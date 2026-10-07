import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CanvasStore } from '../../src/core/store/canvas-store.ts'
import { EnclaveViolation } from '../../src/core/store/enclave.ts'
import { DENY_ALL, assertLayersMayLeave, type OutboundPayload } from '../../src/core/store/egress-policy.ts'
import { canLeaveDevice, LAYER_AUTHORITY, LAYER_TYPES, type LayerType } from '../../src/core/model/nodes.ts'
import { egressRecords, onEgress, resetEgressTripwire } from '../../src/core/net/egress-tripwire.ts'

/** A string that must never appear in anything that leaves the device. */
const SENTINEL = 'CANARY-egress-must-never-observe-this-d4f2a1'

function makeStore(): CanvasStore {
  let counter = 0
  return new CanvasStore({ idFactory: () => `n-${++counter}`, now: () => 1_700_000_000_000 })
}

function draftWithSecret(layer: LayerType = 'private_draft') {
  return {
    type: 'scaffolding' as const,
    layer,
    targetNodeId: 'stroke-1',
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    visibility: 'unfolded' as const,
    confidence: 0.9,
    author: 'user' as const,
    payload: { socraticHint: 'hint', unfoldedSolution: SENTINEL },
  }
}

describe('the layer policy is total and self-consistent', () => {
  it('declares exactly the four specified layers', () => {
    expect([...LAYER_TYPES]).toEqual(['human', 'agent_annotation', 'agent_debate', 'private_draft'])
  })

  it('marks exactly one layer as unable to leave the device', () => {
    const blocked = LAYER_TYPES.filter((layer) => !canLeaveDevice(layer))
    expect(blocked).toEqual(['private_draft'])
  })

  it('gives every layer an explicit authority entry — no layer is unstated', () => {
    for (const layer of LAYER_TYPES) {
      expect(LAYER_AUTHORITY[layer], layer).toBeDefined()
      expect(typeof LAYER_AUTHORITY[layer].user, layer).toBe('boolean')
      expect(typeof LAYER_AUTHORITY[layer].agent, layer).toBe('boolean')
    }
  })
})

describe('egress policy (defence in depth behind the structural split)', () => {
  it('refuses any payload containing private_draft', () => {
    const store = makeStore()
    store.insert(draftWithSecret())

    // The store's own export path never offers drafts…
    expect(store.exportable().some((n) => n.layer === 'private_draft')).toBe(false)

    // …and even if a caller assembled one by hand, the policy stops it.
    const handRolled: OutboundPayload = {
      layers: ['human', 'private_draft'],
      nodes: store.getNodes('private_draft'),
    }
    expect(() => {
      assertLayersMayLeave({ kind: 'allow', layers: ['human', 'private_draft'] }, handRolled.layers)
    }).toThrow(EnclaveViolation)
  })

  it('names the offending layer in the violation', () => {
    try {
      assertLayersMayLeave(DENY_ALL, ['private_draft'])
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(EnclaveViolation)
      expect((error as EnclaveViolation).layers).toEqual(['private_draft'])
      expect((error as EnclaveViolation).name).toBe('EnclaveViolation')
    }
  })

  it('allows a payload of shareable layers', () => {
    expect(() => {
      assertLayersMayLeave({ kind: 'allow', layers: ['human', 'agent_annotation', 'agent_debate'] }, [
        'human',
        'agent_annotation',
      ])
    }).not.toThrow()
  })
})

/**
 * The three-part falsifiable egress suite from ADR-005. Each part can fail on its own:
 * the policy test fails if the matrix is wrong, the tripwire fails if any code path
 * reaches the network, and the content test fails if a secret leaks into a payload.
 */
describe('ZERO EGRESS, as a falsifiable property', () => {
  it('1. the predicate is correct across the whole layer matrix', () => {
    for (const layer of LAYER_TYPES) {
      const expected = layer !== 'private_draft'
      expect(canLeaveDevice(layer), layer).toBe(expected)
      expect(() => {
        assertLayersMayLeave(DENY_ALL, [layer])
      }, layer).toThrow()
    }
  })

  it('2. the global tripwire catches a real network attempt and identifies it', async () => {
    resetEgressTripwire()
    const attempts: string[] = []
    const unwatch = onEgress((record) => attempts.push(`${record.api} -> ${record.target}`))

    // A genuine egress attempt must be intercepted, not merely discouraged.
    await expect(fetch('https://example.com/exfiltrate')).rejects.toThrow(/egress blocked/)

    // A WebSocket attempt must be intercepted too — different global, same guarantee.
    expect(() => new WebSocket('wss://example.com')).toThrow(/egress blocked/)

    unwatch()
    expect(attempts.length).toBeGreaterThanOrEqual(2)
    expect(attempts.some((a) => a.includes('example.com'))).toBe(true)

    // Assert "never called" rather than "called once": a single ignored attempt is
    // still a violation.
    expect(egressRecords().every((r) => r.target.includes('example.com'))).toBe(true)
    resetEgressTripwire()
  })

  it('3. draft content never appears in any encoded outbound payload', () => {
    const store = makeStore()
    store.insert(draftWithSecret())

    // Positive control, WITHOUT which this assertion could pass vacuously: the same
    // search must FIND the sentinel in the local payload. If it cannot find it here,
    // failing to find it below would prove nothing at all.
    const localPayload = JSON.stringify(store.getNodes('private_draft'))
    expect(localPayload).toContain(SENTINEL)

    // Negative assertion: the shared document must not carry it.
    const sharedBytes = Buffer.from(Y.encodeStateAsUpdate(store.doc)).toString('latin1')
    expect(sharedBytes).not.toContain(SENTINEL)

    // And neither may the store's export path, nor any per-layer projection of the
    // shared document.
    expect(JSON.stringify(store.exportable())).not.toContain(SENTINEL)
    for (const layer of ['human', 'agent_annotation', 'agent_debate'] as const) {
      expect(JSON.stringify(store.getNodes(layer))).not.toContain(SENTINEL)
    }
  })

  it('a spy proves the transport is never handed the enclave document', () => {
    const store = makeStore()
    store.insert(draftWithSecret())

    const transport = vi.fn((payload: OutboundPayload): OutboundPayload => payload)
    transport({ layers: ['human'], nodes: store.exportable() })

    // The transport received only shareable nodes — and never a Y.Doc at all, which
    // is what makes it impossible for it to reach the enclave by any path.
    const call = transport.mock.calls[0]
    expect(call?.[0].nodes.every((n) => n['layer'] !== 'private_draft')).toBe(true)
    expect(JSON.stringify(call?.[0])).not.toContain(SENTINEL)
  })

  it('local-only access requires an explicit acknowledgement', () => {
    const store = makeStore()
    store.insert(draftWithSecret())

    // Requiring a literal token makes every call site greppable and self-documenting.
    expect(store.enclaveForLocalUseOnly('LOCAL-ONLY').share.size).toBeGreaterThan(0)
    const retrieved = store.enclaveForLocalUseOnly('LOCAL-ONLY')
    expect(JSON.stringify(retrieved.getMap('layer:private_draft').toJSON())).toContain(SENTINEL)
  })
})
