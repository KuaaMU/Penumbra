/**
 * SpatialIndex — an R-Tree over spatial node bounds, split at the enclave boundary.
 *
 * Two trees, not one (ADR-006). rbush stores items *by reference* and never clones, so
 * a single tree spanning the boundary would make "mutate a node's bounds after
 * insertion" a privacy bug rather than merely a rendering bug. Inserted records are
 * frozen, so that mistake throws in development instead of silently desynchronising the
 * stored bounding box from the object.
 *
 * Two further habits this wrapper exists to enforce:
 *  - `remove()` always receives an `equalsFn`. Without it rbush degrades to reference
 *    equality and returns unchanged *with no exception* — which looks exactly like a
 *    successful delete.
 *  - Bounding boxes are clamped and validated here, because an inverted box makes
 *    rbush walk the entire tree (mourner/rbush#129). On an infinite canvas a fast pan
 *    produces inverted boxes routinely.
 */
import RBush from 'rbush'
import { spatialBoundsSchema, type BoundingBox2D, type LayerType, type NodeId } from '../model/nodes.ts'
import { isEnclaveLayer } from '../store/layers.ts'

export interface SpatialItem {
  readonly id: string
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
  readonly layer: LayerType
}

/**
 * rbush's own intersection predicate, replicated exactly.
 *
 * It is inclusive on every edge: two boxes that merely touch return as intersecting.
 * A brute-force reference written with strict `<`/`>` disagrees on precisely those
 * inputs, which is how a correct implementation ends up failing a correctness test.
 */
export function boxesIntersect(a: BoundingBox2D, b: BoundingBox2D): boolean {
  return b.minX <= a.maxX && b.minY <= a.maxY && b.maxX >= a.minX && b.maxY >= a.minY
}

export class SpatialIndex {
  #world: RBush<SpatialItem>
  #private: RBush<SpatialItem>
  /** The exact object handed to rbush, so removal can match on identity-derived id. */
  readonly #byId = new Map<string, SpatialItem>()

  constructor(maxEntries = 16) {
    // 16 is the README's own bulk-load recommendation; rbush silently clamps the
    // minimum to 4, so a smaller request would silently get the worst case for
    // empty-node accumulation.
    this.#world = new RBush<SpatialItem>(maxEntries)
    this.#private = new RBush<SpatialItem>(maxEntries)
  }

  get size(): number {
    return this.#byId.size
  }

  #treeFor(layer: LayerType): RBush<SpatialItem> {
    return isEnclaveLayer(layer) ? this.#private : this.#world
  }

  /** The tree that is allowed to be consulted by code that talks to agents or MCP. */
  get shareableSize(): number {
    return this.#world.all().length
  }

  get enclaveSize(): number {
    return this.#private.all().length
  }

  #toItem(nodeId: NodeId | string, bounds: BoundingBox2D, layer: LayerType): SpatialItem {
    const box = spatialBoundsSchema.parse(bounds)
    // Frozen because rbush holds this object by reference for the tree's lifetime.
    return Object.freeze({ id: nodeId, minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY, layer })
  }

  upsert(nodeId: NodeId | string, bounds: BoundingBox2D, layer: LayerType): void {
    const item = this.#toItem(nodeId, bounds, layer)
    const previous = this.#byId.get(item.id)
    if (previous) {
      // rbush's reference-based removal would silently no-op here if the caller's
      // copy differs from ours; matching on id makes it deterministic.
      this.#treeFor(previous.layer).remove(previous, (a, b) => a.id === b.id)
    }
    this.#treeFor(item.layer).insert(item)
    this.#byId.set(item.id, item)
  }

  /** Bulk path. rbush's load() is 2-3x faster to build than a loop of insert(). */
  load(items: readonly { id: string; bounds: BoundingBox2D; layer: LayerType }[]): void {
    if (items.length === 0) return
    const shareable: SpatialItem[] = []
    const enclave: SpatialItem[] = []
    for (const { id, bounds, layer } of items) {
      const item = this.#toItem(id, bounds, layer)
      this.#byId.set(item.id, item)
      ;(isEnclaveLayer(layer) ? enclave : shareable).push(item)
    }
    if (shareable.length > 0) this.#world.load(shareable)
    if (enclave.length > 0) this.#private.load(enclave)
  }

  remove(nodeId: NodeId | string): boolean {
    const item = this.#byId.get(nodeId)
    if (!item) return false
    // rbush returns `this` for chaining, so success must be determined by checking
    // membership rather than by inspecting the return value.
    this.#treeFor(item.layer).remove(item, (a, b) => a.id === b.id)
    this.#byId.delete(nodeId)
    return true
  }

  /**
   * Search. `layer` restricts the query to one tree.
   *
   * With no `layer`, BOTH trees are searched — the viewport query is a correctness
   * question ("what is on screen"), and the renderer is entitled to see drafts it is
   * already displaying. Isolation is enforced at the *egress* boundary, not by
   * hiding geometry from local rendering code; `searchEnclave` exists for callers
   * that specifically want only drafts.
   */
  search(box: BoundingBox2D, layer?: LayerType): SpatialItem[] {
    const query = spatialBoundsSchema.parse(box)
    const trees = layer ? [this.#treeFor(layer)] : [this.#world, this.#private]
    const out: SpatialItem[] = []
    for (const tree of trees) out.push(...tree.search(query))
    // All three shareable layers live in ONE rbush tree; the two-tree split marks the
    // enclave boundary only. So a layer-scoped query needs an explicit filter — and
    // needs a test asserting it, or "restricted to human" silently means "everything
    // in the shareable tree".
    return layer ? out.filter((item) => item.layer === layer) : out
  }

  /** Search only the shareable trees — the projection an agent or MCP caller sees. */
  searchShareable(box: BoundingBox2D): SpatialItem[] {
    return this.#world.search(spatialBoundsSchema.parse(box))
  }

  /** Explicit, greppable enclave access. Requires naming the intent. */
  searchEnclave(box: BoundingBox2D): SpatialItem[] {
    return this.#private.search(spatialBoundsSchema.parse(box))
  }

  collides(box: BoundingBox2D): boolean {
    return this.#world.collides(spatialBoundsSchema.parse(box))
  }

  clear(): void {
    this.#world.clear()
    this.#private.clear()
    this.#byId.clear()
  }

  /**
   * Rebuild. rbush retains empty nodes by design after removals (mourner/rbush#78),
   * so search latency ratchets upward over hours of editing even when results stay
   * correct. An ambient always-on canvas needs this more than a short-lived script.
   */
  compact(): void {
    this.#world = new RBush<SpatialItem>(16).load(this.#world.all())
    this.#private = new RBush<SpatialItem>(16).load(this.#private.all())
  }
}

/**
 * Keep a SpatialIndex in step with a CanvasStore.
 *
 * Batch every write from one observer pass into a single load()/remove() round: one
 * CRDT merge can produce dozens of events, and a per-event insert() is both slower
 * and a worse fit for the tree than a bulk build.
 */
export function indexFromNodes(
  nodes: readonly {
    id: string
    bounds: BoundingBox2D
    layer: LayerType
    // `| undefined` rather than a bare optional so this accepts zod-inferred records
    // directly under exactOptionalPropertyTypes.
    tombstone?: boolean | undefined
  }[],
  index = new SpatialIndex(),
): SpatialIndex {
  const live: { id: string; bounds: BoundingBox2D; layer: LayerType }[] = []
  for (const node of nodes) {
    if (node.tombstone === true) index.remove(node.id)
    else live.push({ id: node.id, bounds: node.bounds, layer: node.layer })
  }
  index.load(live)
  return index
}
