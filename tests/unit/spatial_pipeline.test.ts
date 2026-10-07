import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CanvasStore, type NewNodeInput } from '../../src/core/store/canvas-store.ts'
import { SpatialIndex, indexFromNodes } from '../../src/core/spatial/spatial-index.ts'
import type { SpatialNode } from '../../src/core/model/nodes.ts'

const VIEWPORT_ALL = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }

/**
 * The CRDT → index pipeline, which is the actual deliverable of Task 0.3: a spatial
 * index that stays in step with a live document, not an index in isolation.
 */
function makeStore(prefix = 'n'): CanvasStore {
  let counter = 0
  return new CanvasStore({ idFactory: () => `${prefix}-${++counter}`, now: () => 1_700_000_000_000 })
}

/** A complete stroke node with overridable fields — never a partial, so the
 *  discriminated union stays assignable under exactOptionalPropertyTypes. */
function stroke(overrides: Partial<NewNodeInput> = {}): NewNodeInput {
  return {
    type: 'stroke',
    layer: 'human',
    bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    visibility: 'subconscious',
    confidence: 1,
    author: 'user',
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ],
    ...overrides,
  } as NewNodeInput
}

describe('CRDT to R-Tree pipeline', () => {
  it('indexes every node currently in the store', () => {
    const store = makeStore()
    for (let i = 0; i < 50; i++) {
      store.insert(stroke({ bounds: { minX: i * 10, minY: 0, maxX: i * 10 + 50, maxY: 50 } }))
    }

    const index = indexFromNodes(store.getNodes())
    expect(index.size).toBe(50)
    expect(index.search({ minX: 0, minY: 0, maxX: 100, maxY: 100 }).length).toBeGreaterThan(0)
  })

  it('keeps the index in step with store mutations', () => {
    const store = makeStore()
    const index = new SpatialIndex()

    const node = store.insert(stroke({ bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } }))
    index.upsert(node.id, node.bounds, node.layer)
    expect(index.search({ minX: 0, minY: 0, maxX: 100, maxY: 100 })).toHaveLength(1)

    // Moving a node must not leave it findable at its old location.
    const moved = store.update(node.id, { bounds: { minX: 5_000, minY: 5_000, maxX: 5_100, maxY: 5_100 } })
    index.upsert(moved.id, moved.bounds, moved.layer)
    expect(index.search({ minX: 0, minY: 0, maxX: 100, maxY: 100 })).toHaveLength(0)
    expect(index.search({ minX: 4_900, minY: 4_900, maxX: 5_200, maxY: 5_200 })).toHaveLength(1)

    // Tombstoning must drop it from the index.
    store.remove(node.id)
    index.remove(node.id)
    expect(index.size).toBe(0)
  })

  it('routes enclave nodes to the enclave tree and keeps them out of the shareable view', () => {
    const store = makeStore()
    store.insert(stroke({ layer: 'human' }))
    store.insert(stroke({ layer: 'private_draft' }))
    store.insert(stroke({ layer: 'agent_annotation' }))

    const nodes: SpatialNode[] = store.getNodes()
    const index = indexFromNodes(nodes)

    expect(index.size).toBe(3)
    expect(index.shareableSize).toBe(2)
    expect(index.enclaveSize).toBe(1)

    const box = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }
    expect(index.searchShareable(box)).toHaveLength(2)
    expect(index.searchShareable(box).some((f) => f.layer === 'private_draft')).toBe(false)
    expect(index.searchEnclave(box)).toHaveLength(1)
  })

  it('rebuilds the index correctly from two peers that have merged their documents', () => {
    const store = makeStore('peerA')
    const peer = makeStore('peerB')

    const a = store.insert(stroke({ bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } }))
    const b = peer.insert(stroke({ bounds: { minX: 900, minY: 900, maxX: 950, maxY: 950 } }))

    // Each index alone knows one node — that is the divergence.
    const indexA = indexFromNodes(store.getNodes())
    const indexPeer = indexFromNodes(peer.getNodes())
    expect(indexA.size).toBe(1)
    expect(indexPeer.size).toBe(1)

    // Merge the documents the way Yjs actually merges: an update, not a concatenation
    // of node lists. Concatenating would paper over a real convergence bug.
    Y.applyUpdate(store.doc, Y.encodeStateAsUpdate(peer.doc))
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(store.doc))

    // After the merge both peers describe the same spatial world.
    const indexMerged = indexFromNodes(store.getNodes())
    expect(indexMerged.size).toBe(2)
    expect(indexMerged.search({ minX: 0, minY: 0, maxX: 100, maxY: 100 }).map((f) => f.id)).toContain(a.id)
    expect(indexMerged.search({ minX: 800, minY: 800, maxX: 1_000, maxY: 1_000 }).map((f) => f.id)).toContain(b.id)

    // And rebuilding from either peer yields an identical index — the property that
    // actually matters for a CRDT-backed spatial index.
    const fromPeer = indexFromNodes(peer.getNodes())
    expect(new Set(fromPeer.search(VIEWPORT_ALL).map((f) => f.id))).toEqual(
      new Set(indexMerged.search(VIEWPORT_ALL).map((f) => f.id)),
    )
  })
})
