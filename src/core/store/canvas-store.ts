/**
 * CanvasStore — the Phase 0 CRDT substrate.
 *
 * Two documents, not one (ADR-002):
 *   - `doc`        the shared document holding human / agent_annotation / agent_debate
 *   - `enclaveDoc` a separate document holding private_draft, never given to a transport
 *
 * Yjs cannot express "serialise everything except this namespace": one transaction
 * emits one merged byte array, `encodeStateAsUpdate` filters only by per-client clock,
 * and a subdocument integrates into its parent's update. Isolation therefore has to be
 * structural — an object that is never passed anywhere — not a runtime filter.
 *
 * Every layer is a *root type* (`doc.getMap('layer:human')`) rather than a nested map.
 * Root types encode more cheaply (a string key, not a parent-item id) and — the reason
 * that matters — items in different root types can never conflict, because they live
 * in disjoint maps and the conflict-resolution walk never crosses between them.
 */
import * as Y from 'yjs'
import {
  PROMOTION_CONFIDENCE_THRESHOLD,
  spatialNodeSchema,
  canTransition,
  canWriteLayer,
  type LayerType,
  type SpatialNode,
  type StrokeNode,
  type ScaffoldingNode,
  type PDFSnippetNode,
  type TransitionActor,
  type VisibilityLevel,
} from '../model/nodes.ts'
import { ENCLAVE_LAYER, LAYER_ROOT_NAMES, SHAREABLE_LAYERS, type ShareableLayer } from './layers.ts'

/**
 * Three arrays, and all three are load-bearing.
 *
 *  `nodes`  the records that changed and are still live
 *  `layer`  which root map they changed in — the enclave is a different Y.Doc, so a
 *           batch that touched both reports once per document
 *  `removed` ids that went away, by tombstone or by hard Y.Map delete
 *
 * The third argument is why this is not just a widened signature. Before it, `remove()`
 * emitted `nodes: []` — `getNodeById` filters tombstones, so the deletion was erased on
 * the way out — and a consumer that rebuilds state from events could not tell "this node
 * was deleted" from "this layer is now empty". An R-Tree sync built on that signal keeps
 * a phantom entry forever.
 */
export type NodeListener = (
  nodes: readonly SpatialNode[],
  layer: LayerType,
  removed: readonly string[],
) => void

export interface CanvasStoreOptions {
  /** Deterministic ids in tests; a UUIDv7-shaped id in production. */
  readonly idFactory?: () => string
  readonly now?: () => number
}

export type NewNodeInput =
  | (Omit<StrokeNode, 'id' | 'createdAt' | 'schemaVersion'> & { id?: string; createdAt?: number })
  | (Omit<ScaffoldingNode, 'id' | 'createdAt' | 'schemaVersion'> & { id?: string; createdAt?: number })
  | (Omit<PDFSnippetNode, 'id' | 'createdAt' | 'schemaVersion'> & { id?: string; createdAt?: number })

export class LayerAuthorityError extends Error {
  readonly name = 'LayerAuthorityError'
}

export class IllegalTransitionError extends Error {
  readonly name = 'IllegalTransitionError'
}

/**
 * A patch tried to move a node between layers.
 *
 * `layer` is write-once (SPEC_DATA_MODELS.md). The reason is structural, not stylistic:
 * each layer is its own Y.Map root, so relocating a record means writing to one map and
 * deleting from another — and if the delete is ever missed the id exists in both, while
 * every read path that scans by layer now has two answers. More seriously, the enclave
 * lives in a separate Y.Doc that is never handed to a transport, so a `private_draft`
 * record relocated into `human` is copied into `doc` — and from that moment
 * `Y.encodeStateAsUpdate(doc)` carries it to every peer.
 *
 * Promotion out of a tier is legitimate and is modelled by `promotedFromNodeId`: a NEW
 * node is inserted on the destination layer, pointing back at its origin.
 */
export class IllegalLayerChangeError extends Error {
  readonly name = 'IllegalLayerChangeError'
}

/** Highest tier an actor may author a node at directly, without walking the table. */
const CREATION_CEILING: Record<TransitionActor, VisibilityLevel> = {
  // A user writing their own unfolding solution is not an AI dumping a derivation —
  // the invariant is about agents. The user still has to open it tier by tier.
  user: 'unfolded',
  // An agent may speak up to divergence: a comparative debate. Never unfolded.
  agent: 'divergence',
}

const TIER_ORDER: Record<VisibilityLevel, number> = {
  subconscious: 0,
  glow: 1,
  scaffold: 2,
  divergence: 3,
  unfolded: 4,
}

export class CanvasStore {
  readonly doc: Y.Doc
  readonly enclaveDoc: Y.Doc

  readonly #layers: ReadonlyMap<LayerType, Y.Map<unknown>>
  readonly #enclave: Y.Map<unknown>
  readonly #idFactory: () => string
  readonly #now: () => number
  readonly #listeners = new Set<NodeListener>()
  /** Reentrancy guard for batch(); Yjs transactions cannot span two Y.Docs. */
  #batching = 0
  #destroyed = false

  constructor(options: CanvasStoreOptions = {}) {
    // gc:false — GC replaces deleted items with ContentDeleted at transaction time,
    // so two documents that performed the same deletion at different moments encode to
    // different bytes. Convergence tests compare encoded bytes, so GC would make them
    // fail for reasons that have nothing to do with the invariant under test.
    this.doc = new Y.Doc({ gc: false })
    this.enclaveDoc = new Y.Doc({ gc: false })

    this.#idFactory = options.idFactory ?? defaultIdFactory
    this.#now = options.now ?? Date.now

    const layers = new Map<LayerType, Y.Map<unknown>>()
    for (const layer of SHAREABLE_LAYERS) {
      layers.set(layer, this.doc.getMap<unknown>(LAYER_ROOT_NAMES[layer]))
    }
    layers.set(ENCLAVE_LAYER, this.enclaveDoc.getMap<unknown>(LAYER_ROOT_NAMES[ENCLAVE_LAYER]))
    this.#layers = layers
    const enclave = layers.get(ENCLAVE_LAYER)
    if (!enclave) throw new Error('Penumbra: failed to initialise the enclave layer')
    this.#enclave = enclave

    for (const map of this.#layers.values()) {
      map.observeDeep((events) => {
        const layer = this.#layerOf(map)
        if (!layer) return
        this.#emit(layer, events)
      })
    }
  }

  #layerOf(map: Y.Map<unknown>): LayerType | undefined {
    for (const [layer, candidate] of this.#layers) if (candidate === map) return layer
    return undefined
  }

  #emit(layer: LayerType, events: readonly Y.YEvent<Y.AbstractType<unknown>>[]): void {
    const changed = new Set<string>()
    for (const event of events) {
      if (!(event instanceof Y.YMapEvent)) continue
      // Y.Map keys are strings, so keysChanged needs no conversion.
      for (const key of event.keysChanged as Set<string>) changed.add(key)
    }
    if (changed.size === 0) return

    // A key can be gone two ways. `remove()` tombstones, so the record is still in the
    // map and reads as present. A peer merge, or any direct `map.delete()`, removes the
    // key outright. Both are removals and neither can be inferred from `nodes`.
    const live: SpatialNode[] = []
    const removed: string[] = []
    for (const id of changed) {
      const raw = this.#mapFor(layer).get(id)
      const node = raw === undefined ? undefined : (raw as SpatialNode)
      if (node === undefined || node.tombstone === true) removed.push(id)
      else live.push(node)
    }

    for (const listener of this.#listeners) listener(live, layer, removed)
  }

  subscribe(listener: NodeListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Group N writes into one notification per document touched.
   *
   * Yjs already coalesces per transaction — one `doc.transact()` yields one observer
   * pass — so this is a thin wrapper over a facility the store simply was not using.
   * Without it, a pen stroke is 60 transactions, 60 listener calls and 60 React renders.
   *
   * The two Y.Docs get two transactions, so a batch spanning both layers still emits one
   * notification per layer. That is a property of Yjs transactions, not a gap here.
   *
   * There is no rollback: if `fn` throws, Yjs has already committed, and this rethrows
   * with the batch closed so later writes still notify exactly once.
   */
  batch<T>(fn: () => T): T {
    if (this.#batching > 0) return fn()
    this.#batching += 1
    try {
      let result!: T
      this.doc.transact(() => {
        result = this.enclaveDoc.transact(() => fn())
      })
      return result
    } finally {
      this.#batching -= 1
    }
  }

  /**
   * Insert a node. Validated before it reaches the CRDT, so a malformed record can
   * never enter the document and become load-bearing for every future peer.
   */
  insert(input: NewNodeInput, actor: TransitionActor = 'user'): SpatialNode {
    this.#assertLive()
    if (!canWriteLayer(input.layer, actor)) {
      throw new LayerAuthorityError(`${actor} may not write to layer "${input.layer}"`)
    }
    // The transition table governs `setVisibility`, which meant an agent could simply
    // author a node born at the top tier, carrying a finished solution, and never pass
    // through the table at all. Authoring IS a transition, so it is bounded here.
    if (TIER_ORDER[input.visibility] > TIER_ORDER[CREATION_CEILING[actor]]) {
      throw new IllegalTransitionError(
        `${actor} may not author a node at "${input.visibility}"; ` +
          `the highest tier available to ${actor} on creation is "${CREATION_CEILING[actor]}". ` +
          'An agent reaches a deeper tier only by the user advancing it.',
      )
    }
    // PROMOTION_CONFIDENCE_THRESHOLD existed for exactly this decision and was
    // referenced nowhere. Asserting `divergence` is a claim the agent must out-earn.
    if (
      actor === 'agent' &&
      input.visibility === 'divergence' &&
      input.confidence < PROMOTION_CONFIDENCE_THRESHOLD
    ) {
      throw new IllegalTransitionError(
        `an agent may not author at "divergence" with confidence ${String(input.confidence)}; ` +
          `${String(PROMOTION_CONFIDENCE_THRESHOLD)} is the bar set for that claim`,
      )
    }

    const node = spatialNodeSchema.parse({
      ...input,
      id: input.id ?? this.#idFactory(),
      createdAt: input.createdAt ?? this.#now(),
      schemaVersion: 1,
    })

    this.#mapFor(node.layer).set(node.id, node)
    return node
  }

  /**
   * Patch an existing record.
   *
   * Every check `setVisibility` performs is repeated here, because `update()` is the
   * general seam: an adapter holding a store reference, a gesture handler, or a peer's
   * merged patch all arrive here, and none of them go through `setVisibility`. A rule
   * enforced only at one door is not an invariant.
   */
  update(id: string, patch: Partial<SpatialNode>, actor: TransitionActor = 'user'): SpatialNode {
    this.#assertLive()
    const existing = this.getNode(id)
    if (!existing) throw new Error(`Penumbra: no node "${id}"`)
    if (existing.tombstone === true) {
      throw new Error(
        `Penumbra: "${id}" is tombstoned. A tombstone is a deletion, not a draft to edit — ` +
          're-insert it (and set promotedFromNodeId) to bring it back.',
      )
    }
    if (!canWriteLayer(existing.layer, actor)) {
      throw new LayerAuthorityError(`${actor} may not modify layer "${existing.layer}"`)
    }
    if (patch.layer !== undefined && patch.layer !== existing.layer) {
      throw new IllegalLayerChangeError(
        `Penumbra: layer is write-once; "${id}" is on "${existing.layer}" and the patch asks ` +
          `for "${patch.layer}". Insert a new node on the destination layer with ` +
          'promotedFromNodeId set to this id instead.',
      )
    }

    const to = patch.visibility
    if (to !== undefined && to !== existing.visibility && !canTransition(existing.visibility, to, actor)) {
      throw new IllegalTransitionError(
        `${actor} may not move "${id}" from "${existing.visibility}" to "${to}"`,
      )
    }

    const next = spatialNodeSchema.parse({ ...existing, ...patch, id, schemaVersion: 1 })
    // Written back to the SAME root map. `patch.layer` is now either absent or equal to
    // `existing.layer`, so this cannot land the record in a second map.
    this.#mapFor(existing.layer).set(id, next)
    return next
  }

  /** Drive progressive disclosure. Rejects any transition the table forbids. */
  setVisibility(id: string, to: VisibilityLevel, actor: TransitionActor): SpatialNode {
    this.#assertLive()
    const existing = this.getNode(id)
    if (!existing) throw new Error(`Penumbra: no node "${id}"`)
    if (existing.visibility === to) return existing
    if (!canTransition(existing.visibility, to, actor)) {
      throw new IllegalTransitionError(
        `${actor} may not move "${id}" from "${existing.visibility}" to "${to}"`,
      )
    }
    // update() re-checks the same rule. That is deliberate duplication: setVisibility is
    // the documented door, update() is the general seam, and a rule that lives at only
    // one of them is not an invariant.
    return this.update(id, { visibility: to }, actor)
  }

  /** Tombstone rather than delete: a hard delete can be resurrected by a late merge. */
  remove(id: string, actor: TransitionActor = 'user'): void {
    this.#assertLive()
    const existing = this.getNode(id)
    if (!existing) return
    if (existing.tombstone === true) return
    if (!canWriteLayer(existing.layer, actor)) {
      throw new LayerAuthorityError(`${actor} may not delete from layer "${existing.layer}"`)
    }
    this.#mapFor(existing.layer).set(id, { ...existing, tombstone: true })
  }

  #assertLive(): void {
    if (this.#destroyed) {
      throw new Error(
        'Penumbra: this store has been destroyed. After destroy() the Y.Docs accept writes ' +
          'and discard them, so a caller gets a record back and an empty document — worse ' +
          'than a throw, because it looks like the write succeeded.',
      )
    }
  }

  getNode(id: string): SpatialNode | undefined {
    const raw = this.#raw(id)
    // A copy, not the stored object. Y.Map.set holds whatever plain JS value it was
    // handed until the document is serialised, so handing out the stored reference lets
    // a renderer rewrite history through a node it merely read — no transaction, and
    // therefore none of update()'s checks.
    return raw === undefined ? undefined : structuredClone(raw)
  }

  #raw(id: string): SpatialNode | undefined {
    for (const map of this.#layers.values()) {
      const raw = map.get(id)
      if (raw !== undefined) return raw as SpatialNode
    }
    return undefined
  }

  getNodeById(id: string): SpatialNode | undefined {
    const node = this.getNode(id)
    return node?.tombstone === true ? undefined : node
  }

  getNodes(layer?: LayerType): SpatialNode[] {
    const layers = layer ? [layer] : [...this.#layers.keys()]
    const out: SpatialNode[] = []
    for (const current of layers) {
      const map = this.#layers.get(current)
      if (!map) continue
      for (const raw of map.values()) {
        const node = raw as SpatialNode
        if (node.tombstone !== true) out.push(node)
      }
    }
    return out
  }

  layerOf(id: string): LayerType | undefined {
    return this.getNode(id)?.layer
  }

  get isEnclaveEmpty(): boolean {
    return this.#enclave.size === 0
  }

  /** Every non-enclave node. The only set an outbound transport may ever be offered. */
  exportable(): SpatialNode[] {
    return this.getNodes().filter((node) => node.layer !== ENCLAVE_LAYER)
  }

  /**
   * The enclave document, deliberately requiring an explicit acknowledgement so it
   * cannot be passed to a transport by accident. Callers must name what they are
   * doing; a reviewer sees every call site.
   */
  enclaveForLocalUseOnly(_acknowledged: 'LOCAL-ONLY'): Y.Doc {
    return this.enclaveDoc
  }

  #mapFor(layer: LayerType): Y.Map<unknown> {
    const map = this.#layers.get(layer)
    if (!map) throw new Error(`Penumbra: unknown layer "${layer}"`)
    return map
  }

  destroy(): void {
    this.#destroyed = true
    this.#listeners.clear()
    this.doc.destroy()
    this.enclaveDoc.destroy()
  }
}

/**
 * Lexicographically sortable, collision-resistant ids: 48-bit millisecond prefix,
 * so ids created later sort later, which makes a replayed log reconstruct the same
 * order it was written in.
 */
let lastId = 0
export function defaultIdFactory(): string {
  const time = Date.now()
  lastId = time === lastId ? lastId + 1 : time
  const random = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')
  return `${lastId.toString(16).padStart(12, '0')}-${random}`
}

export type { ShareableLayer }
