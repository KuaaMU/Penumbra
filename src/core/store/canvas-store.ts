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
  spatialNodeSchema,
  type LayerType,
  type SpatialNode,
  type TransitionActor,
  type StrokeNode,
  type ScaffoldingNode,
  type PDFSnippetNode,
  canTransition,
  canWriteLayer,
  type VisibilityLevel,
} from '../model/nodes.ts'
import { ENCLAVE_LAYER, LAYER_ROOT_NAMES, SHAREABLE_LAYERS, type ShareableLayer } from './layers.ts'

export type NodeListener = (nodes: readonly SpatialNode[], layer: LayerType) => void

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

export class CanvasStore {
  readonly doc: Y.Doc
  readonly enclaveDoc: Y.Doc

  readonly #layers: ReadonlyMap<LayerType, Y.Map<unknown>>
  readonly #enclave: Y.Map<unknown>
  readonly #idFactory: () => string
  readonly #now: () => number
  readonly #listeners = new Set<NodeListener>()

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
      if (event instanceof Y.YMapEvent) {
        // Y.Map keys are strings, so keysChanged needs no conversion.
        for (const key of event.keysChanged as Set<string>) changed.add(key)
        for (const [key, item] of event.changes.keys) {
          if (item.action === 'delete') changed.add(key)
        }
      }
    }
    if (changed.size === 0) return
    const affected = [...changed]
      .map((id) => this.getNodeById(id))
      .filter((node): node is SpatialNode => node !== undefined)
    for (const listener of this.#listeners) listener(affected, layer)
  }

  subscribe(listener: NodeListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Insert a node. Validated before it reaches the CRDT, so a malformed record can
   * never enter the document and become load-bearing for every future peer.
   */
  insert(input: NewNodeInput, actor: TransitionActor = 'user'): SpatialNode {
    if (!canWriteLayer(input.layer, actor)) {
      throw new LayerAuthorityError(`${actor} may not write to layer "${input.layer}"`)
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

  update(id: string, patch: Partial<SpatialNode>, actor: TransitionActor = 'user'): SpatialNode {
    const existing = this.getNode(id)
    if (!existing) throw new Error(`Penumbra: no node "${id}"`)
    if (!canWriteLayer(existing.layer, actor)) {
      throw new LayerAuthorityError(`${actor} may not modify layer "${existing.layer}"`)
    }
    const next = spatialNodeSchema.parse({ ...existing, ...patch, id, schemaVersion: 1 })
    this.#mapFor(next.layer).set(id, next)
    return next
  }

  /** Drive progressive disclosure. Rejects any transition the table forbids. */
  setVisibility(id: string, to: VisibilityLevel, actor: TransitionActor): SpatialNode {
    const existing = this.getNode(id)
    if (!existing) throw new Error(`Penumbra: no node "${id}"`)
    if (existing.visibility === to) return existing
    if (!canTransition(existing.visibility, to, actor)) {
      throw new IllegalTransitionError(
        `${actor} may not move "${id}" from "${existing.visibility}" to "${to}"`,
      )
    }
    return this.update(id, { visibility: to }, actor)
  }

  /** Tombstone rather than delete: a hard delete can be resurrected by a late merge. */
  remove(id: string, actor: TransitionActor = 'user'): void {
    const existing = this.getNode(id)
    if (!existing) return
    if (!canWriteLayer(existing.layer, actor)) {
      throw new LayerAuthorityError(`${actor} may not delete from layer "${existing.layer}"`)
    }
    this.#mapFor(existing.layer).set(id, { ...existing, tombstone: true })
  }

  getNode(id: string): SpatialNode | undefined {
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
