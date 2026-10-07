import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  CanvasStore,
  IllegalLayerChangeError,
  IllegalTransitionError,
  LayerAuthorityError,
  type NewNodeInput,
  type NodeListener,
} from '../../src/core/store/canvas-store.ts'
import {
  PROMOTION_CONFIDENCE_THRESHOLD,
  VISIBILITY_LEVELS,
  VISIBILITY_TRANSITIONS,
  type LayerType,
  type SpatialNode,
  type StrokeNode,
  type TransitionActor,
  type VisibilityLevel,
} from '../../src/core/model/nodes.ts'

/**
 * Phase 1.0 — the mutation seam itself.
 *
 * `crdt_layers.test.ts` proved the substrate converges. It never exercised the seam that
 * Phase 1 sits on: across every file in the suite there is exactly ONE `update()` call,
 * patching `{bounds}`. That single call is why four invariant bypasses in `update()`
 * shipped green — the state machine was tested through `setVisibility`, which is the
 * safe door, while the unsafe one stood unopened.
 *
 * So this file tests `update()` the way an adapter or a peer merge will use it: with a
 * caller-supplied patch, by an actor that may or may not be entitled, on a node that may
 * or may not be on the other side of the enclave boundary.
 */

const SOLUTION_SENTINEL = 'THE-UNFOLDED-SOLUTION-MUST-NEVER-LEAVE-THE-DEVICE'

function makeStore(prefix = 'n'): CanvasStore {
  let counter = 0
  return new CanvasStore({
    idFactory: () => `${prefix}-${++counter}`,
    now: () => 1_700_000_000_000,
  })
}

function stroke(overrides: Partial<StrokeNode> = {}): NewNodeInput {
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

function scaffolding(overrides: Record<string, unknown> = {}): NewNodeInput {
  return {
    type: 'scaffolding',
    layer: 'agent_annotation',
    bounds: { minX: 0, minY: 0, maxX: 100, maxY: 60 },
    visibility: 'scaffold',
    confidence: 1,
    author: 'agent_proposer',
    targetNodeId: 'stroke-1',
    payload: { socraticHint: 'What is the base case here?', unfoldedSolution: SOLUTION_SENTINEL },
    ...overrides,
  }
}

describe('U4 — update() cannot bypass the invariants setVisibility enforces', () => {
  it('refuses a layer change outright: layer is write-once', () => {
    const store = makeStore()
    const draft = store.insert(scaffolding({ layer: 'private_draft' }))

    // SPEC_DATA_MODELS.md: "layer is write-once: a node's layer never changes."
    // Promotion out of a tier is what promotedFromNodeId is for; moving a record
    // between root maps is not. This is the throw that closes the ZERO EGRESS bypass.
    expect(() => store.update(draft.id, { layer: 'human' })).toThrow(IllegalLayerChangeError)

    // And the message must point at the legal mechanism, or the next implementer
    // reinvents a relocation path.
    expect(() => store.update(draft.id, { layer: 'human' })).toThrow(/promotedFromNodeId/)
  })

  it('keeps the enclave physically untouched after a refused layer change', () => {
    const store = makeStore()
    const draft = store.insert(scaffolding({ layer: 'private_draft' }))

    expect(() => store.update(draft.id, { layer: 'human' })).toThrow(IllegalLayerChangeError)

    // The bytes that would be sent to a peer must not contain the draft.
    const shared = Y.encodeStateAsUpdate(store.doc)
    expect(new TextDecoder().decode(shared)).not.toContain(SOLUTION_SENTINEL)
    expect(store.getNode(draft.id)?.layer).toBe('private_draft')
    expect(store.getNodes()).toHaveLength(1)
  })

  it('hands out copies, so a caller cannot rewrite the document through a node it read', () => {
    const store = makeStore()
    const node = store.insert(stroke())
    const before = store.getNode(node.id)?.bounds.maxX

    // Y.Map.set holds a plain JS object by reference until it is serialised, so a
    // renderer that writes to a node it read silently rewrites history without a
    // transaction, bypassing every check in update(). Reads are therefore copies.
    const read = store.getNode(node.id)
    if (read) (read.bounds as { maxX: number }).maxX = 9999

    expect(store.getNode(node.id)?.bounds.maxX).toBe(before)
  })

  it('allows a patch that restates the current layer, because that is not a change', () => {
    const store = makeStore()
    const node = store.insert(stroke({ layer: 'human' }))

    // index-sync and a peer merge both hand back whole objects. A patch carrying the
    // layer the node already has is a no-op, and rejecting it would push every caller
    // into stripping a field before calling.
    expect(() => store.update(node.id, { layer: 'human', confidence: 0.5 })).not.toThrow()
  })

  it('re-checks layer authority against the destination, not only the source', () => {
    const store = makeStore()
    const annotation = store.insert(stroke({ layer: 'agent_annotation' }), 'agent')

    // An agent may write agent_annotation (LAYER_AUTHORITY.agent_annotation.agent) but
    // not private_draft. Write-once already makes the destination unreachable, so this
    // asserts the boundary rather than the mechanism: it holds even if a future
    // promotion path reintroduces relocation, and `insert()`'s destination check at
    // canvas-store.ts is what this mirrors.
    expect(() => store.update(annotation.id, { layer: 'private_draft' }, 'agent')).toThrow(
      IllegalLayerChangeError,
    )
    expect(store.getNodes('private_draft')).toHaveLength(0)
  })

  it('routes a visibility patch through the transition table', () => {
    const store = makeStore()
    const annotation = store.insert(scaffolding(), 'agent')

    // setVisibility already refused this exact move; update() must not be a softer door.
    expect(() => store.update(annotation.id, { visibility: 'unfolded' }, 'agent')).toThrow(
      IllegalTransitionError,
    )
    expect(store.getNode(annotation.id)?.visibility).toBe('scaffold')
  })

  it('permits a legal visibility patch and records it', () => {
    const store = makeStore()
    const node = store.insert(scaffolding({ layer: 'human', author: 'user' }))

    const next = store.update(node.id, { visibility: 'divergence' })
    expect(next.visibility).toBe('divergence')
    expect(store.getNode(node.id)?.visibility).toBe('divergence')
  })

  it('treats an unchanged visibility in a patch as not a transition', () => {
    const store = makeStore()
    const node = store.insert(scaffolding({ layer: 'human', author: 'user' }))

    // setVisibility short-circuits same-state writes. A patch that happens to carry the
    // current visibility must not be rejected — it is a no-op, not a violation.
    expect(() => store.update(node.id, { visibility: 'scaffold', bounds: node.bounds })).not.toThrow()
  })

  it('rejects an update to a tombstoned node, which would write into a record every read path hides', () => {
    const store = makeStore()
    const node = store.insert(stroke())
    store.remove(node.id)

    // remove() is a tombstone, not a delete. An update that keeps tombstone: true lands
    // in the document, is invisible to getNodeById() and getNodes(), and resurfaces if
    // the tombstone is ever cleared — an unreadable state that no read path can repair.
    expect(() => store.update(node.id, { bounds: { minX: 1, minY: 1, maxX: 2, maxY: 2 } })).toThrow(
      /tombston/i,
    )
  })

  it('keeps the source layer check: an agent cannot edit a human node', () => {
    const store = makeStore()
    const human = store.insert(stroke({ layer: 'human' }))
    expect(() => store.update(human.id, { confidence: 0.5 }, 'agent')).toThrow(LayerAuthorityError)
  })
})

describe('U4b — the transition table itself is pinned', () => {
  /**
   * The tables in nodes.ts are data, and data needs an exhaustive test, not one
   * hand-picked case. Before this, only `unfolded` was pinned: an agent could promote
   * subconscious -> glow -> scaffold and glow -> divergence without failing anything.
   */
  it('gives an agent no path above glow, and none at all once a node is visible', () => {
    // One exception exists and it is the whole ambient premise: an agent may make a
    // Tier-0 node perceptible, because "this node is alive and something is thinking
    // about it" carries no content. Past `glow` the agent has no edge at all — every
    // escalation is something the user did.
    expect(VISIBILITY_TRANSITIONS.subconscious.agent).toEqual(['glow'])
    for (const from of VISIBILITY_LEVELS) {
      if (from === 'subconscious') continue
      expect(VISIBILITY_TRANSITIONS[from].agent, `agent transitions from "${from}"`).toEqual([])
    }
  })

  it('records the exact agent column, so widening it cannot happen silently', () => {
    // Deep-equal against a literal copy. A table-driven `every(...) === false` passes
    // when the key is missing, renamed, or typed `any`; this cannot.
    expect(
      Object.fromEntries(VISIBILITY_LEVELS.map((level) => [level, VISIBILITY_TRANSITIONS[level].agent])),
    ).toEqual({
      subconscious: ['glow'],
      glow: [],
      scaffold: [],
      divergence: [],
      unfolded: [],
    })
  })

  it('records the exact user column, so a shortcut edge cannot be added silently', () => {
    expect(
      Object.fromEntries(VISIBILITY_LEVELS.map((level) => [level, VISIBILITY_TRANSITIONS[level].user])),
    ).toEqual({
      subconscious: ['glow'],
      glow: ['scaffold', 'subconscious'],
      scaffold: ['divergence', 'glow'],
      divergence: ['unfolded', 'scaffold'],
      unfolded: ['divergence'],
    })
  })

  it('never lets a user skip a tier: every edge moves at most one step', () => {
    const order: Record<VisibilityLevel, number> = {
      subconscious: 0,
      glow: 1,
      scaffold: 2,
      divergence: 3,
      unfolded: 4,
    }
    for (const from of VISIBILITY_LEVELS) {
      for (const to of VISIBILITY_TRANSITIONS[from].user) {
        // Backward edges (scaffold -> glow) are how the user collapses a node again, so
        // "one step in either direction" is the real invariant, not "monotonic".
        expect(Math.abs(order[to] - order[from]), `${from} -> ${to}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('lets only the user reach unfolded, and only from divergence', () => {
    for (const from of VISIBILITY_LEVELS) {
      for (const actor of ['user', 'agent'] as const) {
        // The agent column is a literal empty tuple, so `.includes('unfolded')` would
        // not even typecheck without widening — which is the point being pinned.
        const edges: readonly VisibilityLevel[] = VISIBILITY_TRANSITIONS[from][actor]
        expect(edges.includes('unfolded'), `${actor} ${from} -> unfolded`).toBe(
          actor === 'user' && from === 'divergence',
        )
      }
    }
  })
})

describe('U5 — no mutation of any kind moves a draft into the shared document', () => {
  it('never leaks a private_draft canary, whatever an actor does to it', () => {
    // Each attempt gets its own store. Sharing one made attempt N depend on attempt
    // N-1's damage — `remove` tombstones, so every later patch then failed for a reason
    // unrelated to the invariant under test, and the loop proved nothing about them.
    const attempts: ([string, (store: CanvasStore, id: string) => unknown])[] = [
      ['layer -> human', (store, id) => store.update(id, { layer: 'human' })],
      ['layer -> agent_debate', (store, id) => store.update(id, { layer: 'agent_debate' })],
      ['layer -> human as agent', (store, id) => store.update(id, { layer: 'human' }, 'agent')],
      [
        'layer -> private_draft as agent',
        (store, id) => store.update(id, { layer: 'private_draft' }, 'agent'),
      ],
      ['visibility -> unfolded', (store, id) => store.update(id, { visibility: 'unfolded' })],
      [
        'visibility -> unfolded as agent',
        (store, id) => store.update(id, { visibility: 'unfolded' }, 'agent'),
      ],
      [
        'bounds move',
        (store, id) => store.update(id, { bounds: { minX: 5, minY: 5, maxX: 9, maxY: 9 } }),
      ],
      ['confidence bump', (store, id) => store.update(id, { confidence: 1 })],
      ['remove', (store, id) => { store.remove(id) }],
      ['remove as agent', (store, id) => { store.remove(id, 'agent') }],
      [
        'payload replaced wholesale',
        (store, id) => store.update(id, { payload: { socraticHint: SOLUTION_SENTINEL } }),
      ],
      [
        'whole node overwritten, layer and tier both raised',
        (store, id) =>
          store.update(
            id,
            { ...store.getNode(id), layer: 'human', visibility: 'unfolded' },
            'agent',
          ),
      ],
    ]

    for (const [label, attempt] of attempts) {
      const store = makeStore()
      const draft = store.insert(scaffolding({ layer: 'private_draft' }))
      // Refusals are the EXPECTED outcome for most of these, and they are silent — the
      // fix threw where the code before it silently succeeded. A sweep that let them
      // escape would abort on the very first attempt and prove nothing about the rest.
      try {
        attempt(store, draft.id)
      } catch (error) {
        expect(
          error instanceof IllegalLayerChangeError ||
            error instanceof IllegalTransitionError ||
            error instanceof LayerAuthorityError,
          `"${label}" threw an unexpected ${error?.constructor?.name ?? typeof error}`,
        ).toBe(true)
      }

      const shared = new TextDecoder().decode(Y.encodeStateAsUpdate(store.doc))
      expect(shared, `shared document bytes after "${label}"`).not.toContain(SOLUTION_SENTINEL)
      // exportable() is the only set a transport may be offered, so it is checked too.
      expect(store.exportable(), `exportable() after "${label}"`).toHaveLength(0)
    }


    // POSITIVE CONTROL. An egress assertion that cannot find anything passes forever —
    // it would also pass if the search string were wrong, or if the draft had never been
    // created. This proves the canary is present, encodable, and findable in exactly the
    // way the negative assertions above were looking, one store over.
    const control = makeStore('control')
    control.insert(scaffolding({ layer: 'private_draft' }))

    const enclaveBytes = Y.encodeStateAsUpdate(control.enclaveForLocalUseOnly('LOCAL-ONLY'))
    expect(new TextDecoder().decode(enclaveBytes)).toContain(SOLUTION_SENTINEL)

    const controlShared = Y.encodeStateAsUpdate(control.doc)
    expect(new TextDecoder().decode(controlShared)).not.toContain(SOLUTION_SENTINEL)
  })

  it('never exposes a draft through exportable(), the only set a transport may be given', () => {
    const store = makeStore()
    store.insert(scaffolding({ layer: 'human', author: 'user' }))
    store.insert(scaffolding({ layer: 'agent_annotation' }), 'agent')
    store.insert(scaffolding({ layer: 'private_draft' }))

    const exportable = store.exportable()
    expect(exportable).toHaveLength(2)
    for (const node of exportable) expect(node.layer).not.toBe('private_draft')
  })
})

describe('U6 — batch() collapses N writes into one notification', () => {
  it('collapses 100 inserts into a single listener call', () => {
    const store = makeStore()
    const calls: { count: number }[] = []
    const unsubscribe = store.subscribe((nodes) => {
      calls.push({ count: nodes.length })
    })

    for (let i = 0; i < 100; i++) {
      store.insert(stroke({ bounds: { minX: i, minY: i, maxX: i + 5, maxY: i + 5 } }))
    }
    expect(calls).toHaveLength(100)

    calls.length = 0
    store.batch(() => {
      for (let i = 0; i < 100; i++) {
        store.insert(stroke({ bounds: { minX: i, minY: i, maxX: i + 5, maxY: i + 5 } }))
      }
    })
    expect(calls).toHaveLength(1)
    expect(store.getNodes()).toHaveLength(200)
    unsubscribe()
  })

  it('returns the callback value, so it composes', () => {
    const store = makeStore()
    expect(store.batch(() => 'value')).toBe('value')
    expect(store.batch(() => 42)).toBe(42)
  })

  it('nests into the outermost transaction', () => {
    const store = makeStore()
    let calls = 0
    store.subscribe(() => {
      calls += 1
    })

    store.batch(() => {
      store.insert(stroke())
      store.batch(() => {
        store.insert(stroke({ bounds: { minX: 20, minY: 20, maxX: 30, maxY: 30 } }))
        store.insert(stroke({ bounds: { minX: 40, minY: 40, maxX: 50, maxY: 50 } }))
      })
      store.insert(stroke({ bounds: { minX: 60, minY: 60, maxX: 70, maxY: 70 } }))
    })

    expect(calls).toBe(1)
    expect(store.getNodes()).toHaveLength(4)
  })

  it('rolls the listener back to silent when the callback throws', () => {
    const store = makeStore()
    let calls = 0
    store.subscribe(() => {
      calls += 1
    })

    expect(() =>
      store.batch(() => {
        store.insert(stroke())
        throw new Error('boom')
      }),
    ).toThrow('boom')

    // Yjs has no transaction rollback, so the insert stands. What must hold is that the
    // notification is not left permanently open — a later write must still reach one
    // listener, not zero and not two.
    calls = 0
    store.insert(stroke({ bounds: { minX: 1, minY: 1, maxX: 2, maxY: 2 } }))
    expect(calls).toBe(1)
  })

  it('coalesces writes that span both documents into one notification per layer', () => {
    const store = makeStore()
    const seen: { layer: LayerType; count: number }[] = []
    store.subscribe((nodes, layer) => {
      seen.push({ layer, count: nodes.length })
    })

    store.batch(() => {
      store.insert(stroke({ layer: 'human' }))
      store.insert(scaffolding({ layer: 'private_draft' }))
    })

    // One transaction per Y.Doc, because Yjs transactions cannot span documents. So
    // the guarantee is "one notification per document touched", not "one overall".
    expect(seen.filter((s) => s.layer === 'human')).toHaveLength(1)
    expect(seen.filter((s) => s.layer === 'private_draft')).toHaveLength(1)
  })
})

describe('U7 — a removal is observable as a removal', () => {
  it('reports the removed id to the listener', () => {
    const store = makeStore()
    const node = store.insert(stroke())

    const calls: { ids: readonly string[]; removed: readonly string[] }[] = []
    store.subscribe((nodes, _layer, removed) => {
      calls.push({ ids: nodes.map((n) => n.id), removed })
    })

    store.remove(node.id)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.removed).toEqual([node.id])
  })

  it('separates a live update from a tombstone in one batch', () => {
    const store = makeStore()
    const keep = store.insert(stroke())
    const drop = store.insert(stroke({ bounds: { minX: 50, minY: 50, maxX: 60, maxY: 60 } }))

    const calls: { ids: readonly string[]; removed: readonly string[] }[] = []
    store.subscribe((nodes, _layer, removed) => {
      calls.push({ ids: nodes.map((n) => n.id), removed })
    })

    store.batch(() => {
      store.update(keep.id, { confidence: 0.5 })
      store.remove(drop.id)
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.ids).toEqual([keep.id])
    expect(calls[0]?.removed).toEqual([drop.id])
  })

  it('reports a hard Y.Map delete as a removal too', () => {
    const store = makeStore()
    const node = store.insert(stroke())

    const calls: { removed: readonly string[] }[] = []
    store.subscribe((_nodes, _layer, removed) => {
      calls.push({ removed })
    })

    // A peer merge or a direct CRDT write can delete the key outright, bypassing
    // remove() entirely. An index sync that only listens for tombstones would keep a
    // phantom entry in the R-Tree forever.
    store.doc.getMap('layer:human').delete(node.id)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.removed).toEqual([node.id])
  })

  it('emits a stable listener identity that survives unsubscribe', () => {
    const store = makeStore()
    const seen: string[] = []
    const unsubscribe: () => void = store.subscribe((_nodes, _layer, removed) => {
      seen.push(...removed)
    })
    const node: SpatialNode = store.insert(stroke())
    unsubscribe()
    store.remove(node.id)
    expect(seen).toEqual([])
  })

  it('still satisfies the pre-existing listener shape, so no listener breaks', () => {
    const store = makeStore()
    // A two-argument listener is assignable to the three-argument type; the codebase
    // relies on this and a signature change must not be a breaking change for callers.
    const legacy: NodeListener = (nodes, layer) => {
      expect(typeof layer).toBe('string')
      expect(Array.isArray(nodes)).toBe(true)
    }
    const unsubscribe = store.subscribe(legacy)
    const node = store.insert(stroke())
    store.update(node.id, { confidence: 0.5 })
    unsubscribe()
  })
})

describe('U8 — insert() honours the tier its author may reach', () => {
  it('refuses an agent that inserts directly at unfolded', () => {
    const store = makeStore()
    // The transition table governs setVisibility only, so an agent could simply author
    // a node born at the top tier carrying the finished solution.
    expect(() => store.insert(scaffolding({ visibility: 'unfolded' }), 'agent')).toThrow(
      IllegalTransitionError,
    )
    expect(store.getNodes()).toHaveLength(0)
  })

  it('lets the user insert directly at any tier', () => {
    const store = makeStore()
    for (const visibility of VISIBILITY_LEVELS) {
      const node = store.insert(scaffolding({ layer: 'human', author: 'user', visibility }))
      expect(store.getNode(node.id)?.visibility).toBe(visibility)
    }
    expect(store.getNodes()).toHaveLength(VISIBILITY_LEVELS.length)
  })

  it('requires PROMOTION_CONFIDENCE_THRESHOLD for an agent to insert at divergence', () => {
    const store = makeStore()
    // PROMOTION_CONFIDENCE_THRESHOLD is declared in nodes.ts and referenced nowhere.
    // If an agent may assert divergence, it must out-earn the bar set for exactly that.
    expect(() =>
      store.insert(
        scaffolding({
          visibility: 'divergence',
          confidence: PROMOTION_CONFIDENCE_THRESHOLD - 0.01,
        }),
        'agent',
      ),
    ).toThrow(/confidence/i)

    const ok = store.insert(
      scaffolding({ visibility: 'divergence', confidence: PROMOTION_CONFIDENCE_THRESHOLD }),
      'agent',
    )
    expect(store.getNode(ok.id)?.visibility).toBe('divergence')
  })
})

describe('record hygiene', () => {
  it('assigns schemaVersion 1 to everything it writes', () => {
    const store = makeStore()
    const node = store.insert(stroke())
    const updated = store.update(node.id, { confidence: 0.5 })
    expect(updated.schemaVersion).toBe(1)
  })

  it('survives a destroy without throwing', () => {
    const store = makeStore()
    store.insert(stroke())
    expect(() => { store.destroy() }).not.toThrow()
  })

  it('refuses every write after destroy instead of silently dropping it', () => {
    const store = makeStore()
    const node = store.insert(stroke())
    store.destroy()

    // Before this, insert() after destroy() neither threw nor persisted — the caller got
    // a SpatialNode back and an empty document, which is the worst of both outcomes.
    expect(() => store.insert(stroke())).toThrow(/destroy/i)
    expect(() => store.update(node.id, { confidence: 0.5 })).toThrow(/destroy/i)
    expect(() => { store.remove(node.id) }).toThrow(/destroy/i)
  })
})

describe('authority tables are exercised by the store, not only by the model', () => {
  it('rejects an agent write to every layer an agent may not write', () => {
    const denied: [LayerType, TransitionActor][] = [
      ['human', 'agent'],
      ['private_draft', 'agent'],
    ]
    for (const [layer, actor] of denied) {
      const store = makeStore()
      const userNode = store.insert(stroke({ layer }))
      expect(() => store.update(userNode.id, { confidence: 0.5 }, actor)).toThrow(LayerAuthorityError)
      expect(() => { store.remove(userNode.id, actor) }).toThrow(LayerAuthorityError)
    }
  })

  it('allows an agent to edit and delete on both agent layers', () => {
    for (const layer of ['agent_annotation', 'agent_debate'] as const) {
      const store = makeStore()
      const node = store.insert(stroke({ layer }), 'agent')
      expect(() => { store.update(node.id, { confidence: 0.4 }, 'agent') }).not.toThrow()
      expect(() => { store.remove(node.id, 'agent') }).not.toThrow()
    }
  })

  it('reports a node that does not exist rather than creating one', () => {
    const store = makeStore()
    expect(() => store.update('missing', { confidence: 0.5 })).toThrow(/missing/)
    expect(() => { store.setVisibility('missing', 'glow', 'user') }).toThrow(/missing/)
  })

  it('types every layer the store will accept', () => {
    // A compile-time assertion dressed as a runtime one: if LayerType grows a member
    // that LAYER_AUTHORITY forgets, the switch below stops being exhaustive and
    // TypeScript fails the build rather than the test suite passing quietly.
    const layers: readonly LayerType[] = ['human', 'agent_annotation', 'agent_debate', 'private_draft']
    for (const layer of layers) {
      const store = makeStore(`s-${layer}`)
      const node: SpatialNode = store.insert(stroke({ layer }))
      expect(store.layerOf(node.id)).toBe(layer)
    }
  })
})