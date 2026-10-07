/**
 * index-sync — the ONLY writer of a SpatialIndex.
 *
 * A `SpatialIndex` held in step by hand is not held in step. The previous
 * `spatial_pipeline.test.ts` proved the point the wrong way round: it called
 * `index.upsert` itself after every store mutation, so it passed identically against a
 * store that emitted nothing. That left three ways for the tree to drift — a missed
 * tombstone, a stale box after an update, a duplicate after a repeated upsert — with
 * nothing in the suite able to see any of them.
 *
 * Routing every write through one function driven by the store's own notifications makes
 * the coupling testable: `index-sync.test.ts` never touches the index.
 */
import type { SpatialIndex } from '../spatial/spatial-index.ts'
import type { LayerType, SpatialNode } from '../model/nodes.ts'
import type { CanvasStore } from './canvas-store.ts'

/**
 * Apply one `NodeListener` notification.
 *
 * `upsert()` rather than `load()`, per changed node: `RBush.load()` appends, so a second
 * pass over the same id leaves two entries and `size` — which reads a deduplicating Map —
 * reports no change at all. The duplicate is invisible to every count and shows up only
 * as a wrong answer to a query.
 */
export function syncIndex(
  index: SpatialIndex,
  nodes: readonly SpatialNode[],
  _layer: LayerType,
  removed: readonly string[],
): void {
  for (const node of nodes) index.upsert(node.id, node.bounds, node.layer)
  for (const id of removed) index.remove(id)
}

/**
 * Keep `index` in step with `store` and hand the index straight back.
 *
 * Returns the `SpatialIndex` itself, not a wrapper: the call site wants the index, and a
 * handle that only exposes `destroy()` makes `attachIndexSync(...)` read like a factory
 * whose product is somewhere else. `index.stopSyncing()` is the way to detach.
 */
export function attachIndexSync(index: SpatialIndex, store: CanvasStore): SpatialIndex & {
  stopSyncing(): void
} {
  const unsubscribe = store.subscribe((nodes, layer, removed) => {
    syncIndex(index, nodes, layer, removed)
  })
  // A symbol rather than a public field, so it cannot collide with anything SpatialIndex
  // grows later and cannot be confused for part of the index API.
  const STOP = Symbol('penumbra.stopIndexSync')
  const bound = index as SpatialIndex & { stopSyncing(): void }
  Object.defineProperty(bound, STOP, {
    value: () => {
      unsubscribe()
    },
    enumerable: false,
  })
  Object.defineProperty(bound, 'stopSyncing', {
    value: () => {
      unsubscribe()
    },
    enumerable: false,
  })
  return bound
}