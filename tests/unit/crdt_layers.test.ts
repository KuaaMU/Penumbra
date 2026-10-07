import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CanvasStore, LayerAuthorityError, IllegalTransitionError } from '../../src/core/store/canvas-store.ts'
import type { SpatialNode, StrokeNode } from '../../src/core/model/nodes.ts'

function makeStore(prefix = 'n'): CanvasStore {
  let counter = 0
  return new CanvasStore({
    idFactory: () => `${prefix}-${++counter}`,
    now: () => 1_700_000_000_000,
  })
}

function stroke(overrides: Partial<StrokeNode> = {}): Omit<StrokeNode, 'id' | 'createdAt' | 'schemaVersion'> {
  return {
    type: 'stroke',
    layer: 'human',
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    visibility: 'subconscious',
    confidence: 1,
    author: 'user',
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ],
    ...overrides,
  }
}

describe('layer segregation', () => {
  it('holds nodes from all four layers, and reports each layer membership correctly', () => {
    const store = makeStore()

    store.insert(stroke({ layer: 'human' }))
    store.insert(stroke({ layer: 'agent_annotation', author: 'agent_proposer' }), 'agent')
    store.insert(stroke({ layer: 'agent_debate', author: 'agent_skeptic' }), 'agent')
    store.insert(stroke({ layer: 'private_draft' }))

    for (const layer of ['human', 'agent_annotation', 'agent_debate', 'private_draft'] as const) {
      expect(store.getNodes(layer), `layer ${layer}`).toHaveLength(1)
    }
    expect(store.getNodes()).toHaveLength(4)
  })

  it('places private_draft in a different Y.Doc than the shareable layers', () => {
    const store = makeStore()
    const draft = store.insert(stroke({ layer: 'private_draft' }))

    // The structural guarantee (ADR-002): the draft is not merely flagged, it lives
    // in another object graph. No amount of filtering inside one doc could do this.
    const enclaveDoc = store.enclaveForLocalUseOnly('LOCAL-ONLY')
    expect(enclaveDoc.getMap('layer:private_draft').has(draft.id)).toBe(true)

    for (const layer of ['human', 'agent_annotation', 'agent_debate'] as const) {
      expect(store.doc.getMap(`layer:${layer}`).has(draft.id)).toBe(false)
      expect(store.doc.getMap(`layer:${layer}`).size).toBe(0)
    }
  })

  it('refuses an agent write to private_draft', () => {
    const store = makeStore()
    expect(() => store.insert(stroke({ layer: 'private_draft' }), 'agent')).toThrow(LayerAuthorityError)
    // And the refusal must not have written anything.
    expect(store.getNodes('private_draft')).toHaveLength(0)
  })

  it('refuses an agent write to the human layer', () => {
    const store = makeStore()
    expect(() => store.insert(stroke({ layer: 'human' }), 'agent')).toThrow(LayerAuthorityError)
  })

  it('rejects a node whose schema is invalid, so bad records never enter the CRDT', () => {
    const store = makeStore()
    // Confidence outside 0..1 — a node like this would be load-bearing for every peer.
    expect(() =>
      store.insert(stroke({ confidence: 1.4 as unknown as number })),
    ).toThrow()
    expect(store.getNodes()).toHaveLength(0)
  })

  it('rejects an inverted bounding box rather than letting it reach the index', () => {
    const store = makeStore()
    expect(() =>
      store.insert(stroke({ bounds: { minX: 100, minY: 0, maxX: 10, maxY: 10 } })),
    ).toThrow(/non-inverted/)
  })
})

describe('concurrent multi-layer writes', () => {
  /**
   * The anti-tautology guard. A convergence test that compares a document to itself
   * proves nothing; this asserts the two peers genuinely diverge before the merge, so
   * a broken assertion cannot pass by accident.
   */
  it('diverges before merging and converges byte-for-byte afterwards', () => {
    const store = makeStore()
    const a = store.doc
    const b = new Y.Doc({ gc: false })

    // Fork: give B everything A had at birth.
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    // Both peers write offline, concurrently, to different layers.
    a.getMap('layer:human').set('shared-a', { id: 'shared-a', layer: 'human', v: 1 })
    a.getMap('layer:agent_annotation').set('ann-a', { id: 'ann-a', layer: 'agent_annotation' })
    b.getMap('layer:agent_debate').set('deb-b', { id: 'deb-b', layer: 'agent_debate' })
    b.getMap('layer:human').set('shared-b', { id: 'shared-b', layer: 'human', v: 1 })

    const bytesA = Y.encodeStateAsUpdate(a)
    const bytesB = Y.encodeStateAsUpdate(b)
    // Anti-tautology: they must actually differ, or the merge below proves nothing.
    expect(Buffer.from(bytesA).equals(Buffer.from(bytesB))).toBe(false)

    // Merge BOTH directions, as real peers do.
    Y.applyUpdate(a, bytesB)
    Y.applyUpdate(b, bytesA)

    const mergedA = Buffer.from(Y.encodeStateAsUpdate(a))
    const mergedB = Buffer.from(Y.encodeStateAsUpdate(b))
    expect(mergedA.equals(mergedB)).toBe(true)

    for (const id of ['shared-a', 'shared-b', 'ann-a', 'deb-b']) {
      expect(a.getMap(id === 'ann-a' ? 'layer:agent_annotation' : id === 'deb-b' ? 'layer:agent_debate' : 'layer:human').has(id)).toBe(true)
    }
  })

  it('converges on a concurrent write to the same key, deterministically', () => {
    const a = new Y.Doc({ gc: false })
    const b = new Y.Doc({ gc: false })
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    a.getMap('layer:human').set('k', { v: 'from-a' })
    b.getMap('layer:human').set('k', { v: 'from-b' })

    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    // Both peers must agree, and must agree on ONE value — not merge, not duplicate.
    const valueA = a.getMap('layer:human').get('k')
    const valueB = b.getMap('layer:human').get('k')
    expect(valueA).toEqual(valueB)
    expect(a.getMap('layer:human').size).toBe(1)
  })

  it('is idempotent when the same update is replayed', () => {
    const a = new Y.Doc({ gc: false })
    const b = new Y.Doc({ gc: false })
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    a.getMap('layer:human').set('k', { v: 1 })

    const update = Y.encodeStateAsUpdate(a)
    Y.applyUpdate(b, update)
    Y.applyUpdate(b, update)
    Y.applyUpdate(b, update)

    expect(b.getMap('layer:human').size).toBe(1)
    expect(Buffer.from(Y.encodeStateAsUpdate(b)).equals(Buffer.from(Y.encodeStateAsUpdate(a)))).toBe(true)
  })

  it('never leaks enclave content into the shared document, even after a merge', () => {
    const store = makeStore()
    const draft = store.insert(stroke({ layer: 'private_draft' }))
    const shared = store.insert(stroke({ layer: 'human' }))

    // Even a full state exchange — the most aggressive thing a peer can do — moves
    // shared nodes both ways and draft nodes zero times.
    const peer = new Y.Doc({ gc: false })
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(store.doc))
    Y.applyUpdate(store.doc, Y.encodeStateAsUpdate(peer))

    expect(peer.getMap('layer:human').has(shared.id)).toBe(true)
    expect(peer.getMap('layer:human').has(draft.id)).toBe(false)
    expect(JSON.stringify(peer.share).includes(draft.id)).toBe(false)
  })
})

describe('progressive disclosure state machine', () => {
  it('allows the user to unfold through every tier', () => {
    const store = makeStore()
    const node = store.insert({
      type: 'scaffolding',
      layer: 'agent_annotation',
      targetNodeId: 'stroke-1',
      bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      visibility: 'subconscious',
      confidence: 0.9,
      author: 'agent_proposer',
      payload: { socraticHint: 'What assumption makes this step necessary?' },
    })

    store.setVisibility(node.id, 'glow', 'user')
    store.setVisibility(node.id, 'scaffold', 'user')
    store.setVisibility(node.id, 'divergence', 'user')
    const final = store.setVisibility(node.id, 'unfolded', 'user')

    expect(final.visibility).toBe('unfolded')
  })

  /**
   * The invariant that matters most: an agent may never reach `unfolded` on its own
   * initiative, because that would place a direct solution on the canvas without the
   * user asking — exactly what CLAUDE.md Section 1 forbids.
   */
  it('forbids an agent from ever reaching unfolded, from any tier below it', () => {
    const store = makeStore()
    // 'unfolded' itself is excluded deliberately: an agent moving a node that is
    // already unfolded is a no-op, not a transition, and setVisibility returns
    // early rather than throwing. What must be impossible is an agent *arriving*
    // at unfolded on its own initiative.
    for (const start of ['subconscious', 'glow', 'scaffold', 'divergence'] as const) {
      const node = store.insert({
        type: 'scaffolding',
        layer: 'agent_annotation',
        targetNodeId: 'stroke-1',
        bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
        visibility: start,
        confidence: 0.9,
        author: 'agent_proposer',
        payload: { socraticHint: 'hint' },
      })
      expect(() => store.setVisibility(node.id, 'unfolded', 'agent'), `from ${start}`).toThrow(
        IllegalTransitionError,
      )
    }
  })

  it('tombstones rather than deletes, so a late merge cannot resurrect a node', () => {
    const store = makeStore()
    const node = store.insert(stroke())

    store.remove(node.id)
    expect(store.getNodeById(node.id)).toBeUndefined()
    // The record survives in the CRDT — that is what makes resurrection detectable.
    expect(store.getNode(node.id)?.tombstone).toBe(true)
  })

  it('notifies subscribers with the affected nodes', () => {
    const store = makeStore()
    const seen: SpatialNode[][] = []
    const unsubscribe = store.subscribe((nodes) => seen.push([...nodes]))

    const node = store.insert(stroke())
    unsubscribe()
    store.insert(stroke({ layer: 'private_draft' }))

    expect(seen).toHaveLength(1)
    expect(seen[0]?.[0]?.id).toBe(node.id)
  })
})
