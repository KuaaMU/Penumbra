/**
 * The data model, as implemented.
 *
 * This file is the single source of truth for what exists. Where it extends
 * docs/specs/SPEC_DATA_MODELS.md, the divergence is deliberate and recorded:
 *
 *  - `StrokeNode` and `DerivationEdge` exist because `ScaffoldingNode.targetNodeId`
 *    points at "the user stroke or node", but the spec never defined a stroke.
 *  - `EpochMs` and `NodeId` are branded so a raw number cannot be passed where a
 *    timestamp or a spatial node id is required.
 *  - `schemaVersion` replaces the spec's `version`, which conflated two different
 *    things: CRDT merge ordering and record shape.
 *  - The visibility transition table lives here, not in TASKS.md, because it is a
 *    data invariant and prose cannot enforce it.
 */
import { z } from 'zod'

/** Milliseconds since the Unix epoch. Branded so a bare number cannot masquerade. */
export type EpochMs = number & { readonly __brand: unique symbol }

/** A spatial node identifier. Stable for the life of the node; never reused. */
export type NodeId = string & { readonly __brand: unique symbol }

export const LAYER_TYPES = ['human', 'agent_annotation', 'agent_debate', 'private_draft'] as const
export type LayerType = (typeof LAYER_TYPES)[number]

/** Confidence at or above which an agent may promote its own output into view. */
export const PROMOTION_CONFIDENCE_THRESHOLD = 0.8

export const VISIBILITY_LEVELS = [
  'subconscious', // Tier 0: in the CRDT, never drawn
  'glow', // Tier 1: breathing outline, no content
  'scaffold', // Tier 2a: Socratic prompt
  'divergence', // Tier 2b: comparative debate matrix
  'unfolded', // Tier 2c: full derivation — only ever reached by explicit intent
] as const
export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number]

export const AUTHOR_TYPES = ['user', 'agent_proposer', 'agent_skeptic', 'agent_distiller'] as const
export type AuthorType = (typeof AUTHOR_TYPES)[number]

// z.number() already rejects NaN and Infinity in v4, so no `.finite()` is needed.
export const boundingBoxSchema = z.object({
  minX: z.number(),
  minY: z.number(),
  maxX: z.number(),
  maxY: z.number(),
})
export type BoundingBox2D = z.infer<typeof boundingBoxSchema>

/** Rejects inverted or degenerate boxes. A fast pan can otherwise produce maxX < minX,
 *  which makes rbush walk the entire tree (mourner/rbush#129). */
export const spatialBoundsSchema = boundingBoxSchema.refine(
  (b) => b.maxX >= b.minX && b.maxY >= b.minY,
  { message: 'Bounding box must be non-inverted (max >= min on both axes)' },
)

export const baseSpatialNodeSchema = z.object({
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  createdAt: z.number().int().nonnegative(),
  layer: z.enum(LAYER_TYPES),
  bounds: spatialBoundsSchema,
  visibility: z.enum(VISIBILITY_LEVELS),
  confidence: z.number().min(0).max(1),
  author: z.enum(AUTHOR_TYPES),
  // Zod emits `T | undefined` for optional keys, which is incompatible with
  // exactOptionalPropertyTypes under strict mode. Accepting an explicit `undefined`
  // here makes `{ tombstone: undefined }` a valid record — which is exactly what a
  // spread-patch produces, so `update()` works without every caller stripping keys.
  /** Set when this node was promoted out of a lower tier or another layer. */
  promotedFromNodeId: z.string().min(1).optional(),
  /** Marks a deleted node so tombstones survive merge without resurrecting it. */
  tombstone: z.boolean().optional(),
})

export const scaffoldingNodeSchema = baseSpatialNodeSchema.extend({
  type: z.literal('scaffolding'),
  targetNodeId: z.string().min(1),
  payload: z.object({
    socraticHint: z.string().min(1),
    divergenceMatrix: z
      .object({
        proposerClaim: z.string(),
        skepticCounterexample: z.string(),
        underlyingAssumption: z.string(),
      })
      .optional(),
    // Encrypted by default. A renderer that reads this without checking `visibility`
    // is the single most dangerous thing in this codebase.
    unfoldedSolution: z.string().optional(),
  }),
})
export type ScaffoldingNode = z.infer<typeof scaffoldingNodeSchema>

export const strokeNodeSchema = baseSpatialNodeSchema.extend({
  type: z.literal('stroke'),
  /** Points along the pen path. Phase 2's VLM compiler reads these to build the DAG. */
  points: z.array(z.object({ x: z.number(), y: z.number() })).min(2),
  pressure: z.array(z.number().min(0).max(1)).optional(),
})
export type StrokeNode = z.infer<typeof strokeNodeSchema>

export const pdfSnippetNodeSchema = baseSpatialNodeSchema.extend({
  type: z.literal('pdf_snippet'),
  sourceDocumentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  pageIndex: z.number().int().nonnegative(),
  sourceBounds: boundingBoxSchema,
  renderedImageUrl: z.string(),
})
export type PDFSnippetNode = z.infer<typeof pdfSnippetNodeSchema>

export const spatialNodeSchema = z.discriminatedUnion('type', [
  strokeNodeSchema,
  scaffoldingNodeSchema,
  pdfSnippetNodeSchema,
])
export type SpatialNode = z.infer<typeof spatialNodeSchema>

/**
 * The authoritative visibility transition table.
 *
 * CLAUDE.md Section 1 mandates 3-tier progressive disclosure and forbids an agent
 * from ever placing a direct solution on a default layer. Five states encode that;
 * the legal transitions are the whole of the guarantee, so they are data, not prose.
 *
 * `user` transitions require explicit intent. `agent` transitions are capped: an
 * agent may reach `divergence` on its own initiative, but never `unfolded`.
 */
export const VISIBILITY_TRANSITIONS = {
  subconscious: { user: ['glow'], agent: ['glow'] },
  glow: { user: ['scaffold', 'subconscious'], agent: [] },
  scaffold: { user: ['divergence', 'glow'], agent: [] },
  divergence: { user: ['unfolded', 'scaffold'], agent: [] },
  unfolded: { user: ['divergence'], agent: [] },
} as const satisfies Record<VisibilityLevel, Record<'user' | 'agent', readonly VisibilityLevel[]>>

export type TransitionActor = 'user' | 'agent'

export function canTransition(
  from: VisibilityLevel,
  to: VisibilityLevel,
  actor: TransitionActor,
): boolean {
  const allowed: readonly VisibilityLevel[] = VISIBILITY_TRANSITIONS[from][actor]
  return allowed.includes(to)
}

/** What is actually permitted to be drawn at a given tier. The invariant, in one place. */
export const CONTENT_REVEALED_AT: Record<VisibilityLevel, readonly string[]> = {
  subconscious: [],
  glow: [],
  scaffold: ['socraticHint'],
  divergence: ['socraticHint', 'divergenceMatrix'],
  unfolded: ['socraticHint', 'divergenceMatrix', 'unfoldedSolution'],
}

export function revealedFields(node: SpatialNode): readonly string[] {
  if (node.type !== 'scaffolding') return []
  return CONTENT_REVEALED_AT[node.visibility].filter((field) => node.payload[field as keyof typeof node.payload] !== undefined)
}

/**
 * Layer authority (ADR-002).
 *
 * One table, imported by the store AND the tests, so enforcement and documentation
 * cannot drift. `private_draft` is writable only by the user — an agent that can
 * write there can also influence what the user reads there.
 */
export const LAYER_AUTHORITY = {
  human: { user: true, agent: false },
  agent_annotation: { user: true, agent: true },
  agent_debate: { user: true, agent: true },
  private_draft: { user: true, agent: false },
} as const satisfies Record<LayerType, Record<'user' | 'agent', boolean>>

export function canWriteLayer(layer: LayerType, actor: TransitionActor): boolean {
  return LAYER_AUTHORITY[layer][actor]
}

/** Private drafts are the enclave: they may never leave the device (ADR-002/005). */
export function canLeaveDevice(layer: LayerType): boolean {
  return layer !== 'private_draft'
}
