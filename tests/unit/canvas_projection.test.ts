import { describe, expect, it } from 'vitest'
import { projectForVisibility } from '../../src/core/canvas/engine.ts'
import { CONTENT_REVEALED_AT, revealedFields, type ScaffoldingNode } from '../../src/core/model/nodes.ts'

/**
 * The renderer boundary.
 *
 * The dangerous failure in this codebase is a renderer reaching
 * `payload.unfoldedSolution` while the node is still at `glow` — a direct solution
 * landing on the canvas with no user intent, which is exactly what CLAUDE.md Section 1
 * forbids. These tests pin the projection that makes that unreachable.
 */
function scaffolding(visibility: ScaffoldingNode['visibility']): ScaffoldingNode {
  return {
    id: 'n-1',
    schemaVersion: 1,
    createdAt: 1_700_000_000_000,
    type: 'scaffolding',
    layer: 'agent_annotation',
    targetNodeId: 'stroke-1',
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    visibility,
    confidence: 0.9,
    author: 'agent_proposer',
    payload: {
      socraticHint: 'What assumption makes this step necessary?',
      divergenceMatrix: {
        proposerClaim: 'The limit exists.',
        skepticCounterexample: 'It diverges for x > 1.',
        underlyingAssumption: 'That f is monotonic.',
      },
      unfoldedSolution: 'THE ACTUAL DERIVATION',
    },
  }
}

describe('visibility projection', () => {
  it('reveals nothing at Tier 0 or Tier 1', () => {
    for (const visibility of ['subconscious', 'glow'] as const) {
      const projected = projectForVisibility(scaffolding(visibility))
      expect(projected, visibility).toEqual({ type: 'scaffolding', hint: null })
      expect(JSON.stringify(projected)).not.toContain('THE ACTUAL DERIVATION')
      expect(revealedFields(scaffolding(visibility)), visibility).toEqual([])
    }
  })

  it('reveals only the Socratic hint at scaffold', () => {
    const projected = projectForVisibility(scaffolding('scaffold'))
    expect(projected['hint']).toBe('What assumption makes this step necessary?')
    expect(projected).not.toHaveProperty('divergenceMatrix')
    expect(JSON.stringify(projected)).not.toContain('THE ACTUAL DERIVATION')
  })

  it('adds the divergence matrix but still withholds the solution at divergence', () => {
    const projected = projectForVisibility(scaffolding('divergence'))
    expect(projected).toHaveProperty('divergenceMatrix')
    expect(JSON.stringify(projected)).not.toContain('THE ACTUAL DERIVATION')
  })

  it('reveals the solution only at unfolded', () => {
    const projected = projectForVisibility(scaffolding('unfolded'))
    expect(projected['unfoldedSolution']).toBe('THE ACTUAL DERIVATION')
  })

  /**
   * Table-driven over the whole visibility × field matrix, so a new tier cannot be
   * added to CONTENT_REVEALED_AT without this test noticing.
   */
  it('never reveals a field the tier is not authorised to show', () => {
    for (const [visibility, allowed] of Object.entries(CONTENT_REVEALED_AT)) {
      const projected = projectForVisibility(
        scaffolding(visibility as ScaffoldingNode['visibility']),
      )
      for (const field of ['socraticHint', 'divergenceMatrix', 'unfoldedSolution']) {
        const isPresent = Object.hasOwn(projected, field) || (field === 'socraticHint' && projected['hint'] !== null)
        if (!allowed.includes(field)) {
          expect(isPresent, `${visibility} must not reveal ${field}`).toBe(false)
        }
      }
    }
  })

  it('projects a non-scaffolding node without leaking a payload', () => {
    const stroke: ScaffoldingNode['type'] extends never ? never : Parameters<typeof projectForVisibility>[0] = {
      ...scaffolding('unfolded'),
      type: 'stroke',
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    } as unknown as Parameters<typeof projectForVisibility>[0]

    expect(projectForVisibility(stroke)).toEqual({ type: 'stroke' })
  })
})
