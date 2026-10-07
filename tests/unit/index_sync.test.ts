import { describe, expect, it } from 'vitest'
import { CanvasStore, type NewNodeInput } from '../../src/core/store/canvas-store.ts'
import { syncIndex, attachIndexSync } from '../../src/core/store/index-sync.ts'
import { SpatialIndex } from '../../src/core/spatial/spatial-index.ts'
import { referenceSearch, VIEWPORT, type FixtureNode } from '../fixtures/spatial-fixture.ts'
import type { BoundingBox2D, LayerType, SpatialNode } from '../../src/core/model/nodes.ts'

/**
 * The store → index bridge.
 *
 * `spatial_pipeline.test.ts` already had a test called "keeps the index in step with
 * store mutations", and it passed against a store that emitted nothing: the test itself
 * called `index.upsert` after every mutation, so it measured its own bookkeeping. This
 * file removes the test's hands from the wheel — the only writer of the index is now
 * `index-sync.ts`, driven by the store's own notifications.
 */

function makeStore(prefix = 'n'): CanvasStore {
  let counter = 0
  return new CanvasStore({
    idFactory: () => `${prefix}-${++counter}`,
    now: () => 1_700_000_000_000,
  })
}

function box(x: number, y = 0): BoundingBox2D {
  return { minX: x, minY: y, maxX: x + 10, maxY: y + 10 }
}

function strokeAt(x: number, layer: LayerType = 'human'): NewNodeInput {
  return {
    type: 'stroke',
    layer,
    bounds: box(x),
    visibility: 'subconscious',
    confidence: 1,
    author: 'user',
    points: [
      { x, y: 0 },
      { x: x + 10, y: 10 },
    ],
  }
}

function idsOf(index: SpatialIndex, viewport: BoundingBox2D = VIEWPORT): string[] {
  return [...new Set(index.search(viewport).map((f) => f.id))].sort()
}

describe('U8 — index-sync mirrors the store without being told what changed', () => {
  it('indexes a node the moment it is inserted', () => {
    const store = makeStore()
    const index = attachIndexSync(new SpatialIndex(), store)
    const node = store.insert(strokeAt(0))

    expect(index.search(VIEWPORT).map((f) => f.id)).toEqual([node.id])
    store.destroy()
    index.stopSyncing()
  })

  it('follows a bounds update rather than keeping the stale box', () => {
    const store = makeStore()
    const index = attachIndexSync(new SpatialIndex(), store)
    const node = store.insert(strokeAt(0))

    // Far outside VIEWPORT at first. If the sync only handled insertions, the old
    // geometry would answer the query and the new geometry would be unreachable —
    // which is a node that renders where it no longer is.
    expect(idsOf(index)).toEqual([node.id])
    store.update(node.id, { bounds: box(9_000, 9_000) })

    expect(idsOf(index)).toEqual([])
    expect(index.search(box(9_000, 9_000)).map((f) => f.id)).toEqual([node.id])
    store.destroy()
    index.stopSyncing()
  })

  it('drops a tombstoned node', () => {
    const store = makeStore()
    const index = attachIndexSync(new SpatialIndex(), store)
    const node = store.insert(strokeAt(0))
    expect(index.size).toBe(1)

    store.remove(node.id)
    expect(index.size).toBe(0)
    expect(idsOf(index)).toEqual([])
    store.destroy()
    index.stopSyncing()
  })

  it('drops a node deleted outright, which bypasses remove()', () => {
    const store = makeStore()
    const index = attachIndexSync(new SpatialIndex(), store)
    const node = store.insert(strokeAt(0))
    expect(index.size).toBe(1)

    // A hard Y.Map delete — what a peer merge or any direct CRDT write produces. The
    // store reports it as a removal, so the index must too; otherwise the tree keeps
    // a phantom entry forever.
    store.doc.getMap('layer:human').delete(node.id)
    expect(index.size).toBe(0)
    store.destroy()
    index.stopSyncing()
  })

  it('keeps the enclave and the shareable trees on their own sides of the split', () => {
    const store = makeStore()
    const index = attachIndexSync(new SpatialIndex(), store)
    const draft = store.insert(strokeAt(0, 'private_draft'))
    const human = store.insert(strokeAt(0))

    expect(index.searchEnclave(VIEWPORT).map((f) => f.id)).toEqual([draft.id])
    expect(index.searchShareable(VIEWPORT).map((f) => f.id)).toEqual([human.id])
    store.destroy()
    index.stopSyncing()
  })

  it('handles a mixed batch — insert, move, tombstone — exactly', () => {
    const store = makeStore()
    const index = attachIndexSync(new SpatialIndex(), store)
    const keep = store.insert(strokeAt(0))
    const move = store.insert(strokeAt(20))
    const drop = store.insert(strokeAt(40))

    store.batch(() => {
      store.update(move.id, { bounds: box(80) })
      store.remove(drop.id)
    })

    expect(index.search(box(80)).map((f) => f.id)).toEqual([move.id])
    expect(index.search(box(40))).toEqual([])
    expect(index.size).toBe(2)
    expect(new Set(idsOf(index))).toEqual(new Set([keep.id, move.id]))
    store.destroy()
    index.stopSyncing()
  })

  it('leaves the index untouched by a batch that changed nothing renderable', () => {
    const store = makeStore()
    const index = attachIndexSync(new SpatialIndex(), store)
    const node = store.insert(strokeAt(0))
    const before = idsOf(index)
    const sizeBefore = index.size

    store.batch(() => {
      store.update(node.id, { confidence: 0.99 })
    })

    // Same answers, same size. `upsert()` removes the old entry by id before inserting,
    // so a no-op update must not leave a duplicate behind — the exact failure
    // `rebuildIndexFromNodes` has and is why it is not the incremental path.
    expect(idsOf(index)).toEqual(before)
    expect(index.size).toBe(sizeBefore)
    expect(index.search(box(0))).toHaveLength(1)
    store.destroy()
    index.stopSyncing()
  })

  it('matches the brute-force reference over a mixed 400-node workload', () => {
    const store = makeStore()
    const index = attachIndexSync(new SpatialIndex(), store)

    // The real check. Every assertion above is a single-box lookup, which a wrong
    // answer can dodge. This is set equality against an independent implementation —
    // the only form that catches a node indexed in the wrong tree, left behind at its
    // old position, or duplicated.
    //
    // The layout is derived from `node.bounds`, not the grid coordinates, so the
    // reference cannot disagree with the index over something the test got wrong.
    const authored: SpatialNode[] = []
    store.batch(() => {
      for (let i = 0; i < 400; i++) {
        authored.push(
          store.insert(strokeAt((i % 20) * 120, i % 3 === 0 ? 'agent_annotation' : 'human')),
        )
      }
    })

    const moved = new Set(authored.slice(0, 50).map((n) => n.id))
    const RELOCATED: BoundingBox2D = { minX: 4_000, minY: 4_000, maxX: 4_010, maxY: 4_010 }
    store.batch(() => {
      for (const node of authored.slice(0, 50)) store.update(node.id, { bounds: RELOCATED })
      for (const node of authored.slice(50, 80)) store.remove(node.id)
    })

    const expected: FixtureNode[] = store
      .getNodes()
      .map((n) => ({ id: n.id, bounds: n.bounds, layer: n.layer }))

    expect(new Set(idsOf(index))).toEqual(new Set(referenceSearch(expected, VIEWPORT)))
    expect(index.size).toBe(expected.length)
    expect(index.size).toBe(400 - 30)
    // Every relocated node answered only at its new position, never the old one.
    for (const id of moved) {
      expect(index.search(RELOCATED).some((f) => f.id === id)).toBe(true)
    }
    store.destroy()
    index.stopSyncing()
  })

  it('stops listening once detached, so a destroyed store cannot revive the index', () => {
    const store = makeStore()
    const index = attachIndexSync(new SpatialIndex(), store)
    store.insert(strokeAt(0))
    expect(index.size).toBe(1)

    index.stopSyncing()
    store.destroy()
    expect(index.size).toBe(1)
  })
})

describe('syncIndex is a pure function of one notification', () => {
  it('applies a changed node', () => {
    const store = makeStore()
    const node = store.insert(strokeAt(0))
    const index = new SpatialIndex()

    syncIndex(index, [node], 'human', [])
    expect(index.search(box(0)).map((f) => f.id)).toEqual([node.id])
  })

  it('applies a removal', () => {
    const store = makeStore()
    const node = store.insert(strokeAt(0))
    const index = new SpatialIndex()
    syncIndex(index, [node], 'human', [])

    syncIndex(index, [], 'human', [node.id])
    expect(index.size).toBe(0)
  })

  it('routes an enclave node to the enclave tree', () => {
    const store = makeStore()
    const node = store.insert(strokeAt(0, 'private_draft'))
    const index = new SpatialIndex()

    syncIndex(index, [node], 'private_draft', [])
    expect(index.searchEnclave(box(0)).map((f) => f.id)).toEqual([node.id])
    expect(index.searchShareable(box(0))).toEqual([])
  })
})