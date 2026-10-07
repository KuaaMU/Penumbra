# Penumbra Core Data Models & Schemas

## 1. Canvas Node Types & Interfaces

```typescript
export type LayerType = 'human' | 'agent_annotation' | 'agent_debate' | 'private_draft';

export type VisibilityLevel = 
  | 'subconscious' // Level 0: In DB/CRDT, not visible on canvas
  | 'glow'          // Level 1: Subtle breathing outline / anchor
  | 'scaffold'      // Level 2a: Socratic hint / question visible
  | 'divergence'    // Level 2b: Comparative debate matrix
  | 'unfolded';     // Level 2c: Full detail revealed by explicit user intent

export interface BoundingBox2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface BaseSpatialNode {
  id: string;
  /**
   * Shape version of the record itself. Replaces the original `version` field, which
   * conflated two different things — CRDT merge ordering (which Yjs owns, and which is
   * not a field on the record) and record shape.
   */
  schemaVersion: 1;
  createdAt: number;
  layer: LayerType;
  bounds: BoundingBox2D;
  visibility: VisibilityLevel;
  confidence: number; // 0.0 to 1.0
  author: 'user' | 'agent_proposer' | 'agent_skeptic' | 'agent_distiller';
  /** Set when this node was promoted out of a lower tier or another layer. */
  promotedFromNodeId?: string;
  /**
   * A delete is a tombstone, not a hard delete. A hard delete leaves the struct store
   * and can be resurrected by a late-arriving update from a peer that has not yet seen
   * the deletion.
   */
  tombstone?: boolean;
}

export interface ScaffoldingNode extends BaseSpatialNode {
  type: 'scaffolding';
  targetNodeId: string; // The user stroke or node being scaffolded
  payload: {
    socraticHint: string;          // Level 2a
    divergenceMatrix?: {           // Level 2b
      proposerClaim: string;
      skepticCounterexample: string;
      underlyingAssumption: string;
    };
    unfoldedSolution?: string;     // Level 2c (Encrypted/Hidden by default)
  };
}

export interface PDFSnippetNode extends BaseSpatialNode {
  type: 'pdf_snippet';
  sourceDocumentSha256: string;
  pageIndex: number;
  sourceBounds: BoundingBox2D;
  renderedImageUrl: string;
}
```

### 1a. Layer Authority (was unspecified — blocks Task 0.2)

`layer` is **write-once**: a node's layer never changes. Promotion into view creates a new
node carrying `promotedFromNodeId`, which keeps the promotion auditable and keeps the
egress predicate decidable.

| Layer | user may write | agent may write | may leave device |
|---|---|---|---|
| `human` | yes | **no** | yes |
| `agent_annotation` | yes | yes | yes |
| `agent_debate` | yes | yes | yes |
| `private_draft` | yes | **no** | **no** |

Exported as `LAYER_AUTHORITY` from `src/core/model/nodes.ts` and imported by both
`CanvasStore` and the test suite, so enforcement and documentation cannot drift.

### 1b. Visibility Transitions (moved here from TASKS.md — it is a data invariant, not prose)

```typescript
export const VISIBILITY_TRANSITIONS = {
  subconscious: { user: ['glow'], agent: ['glow'] },
  glow:         { user: ['scaffold', 'subconscious'], agent: [] },
  scaffold:     { user: ['divergence', 'glow'], agent: [] },
  divergence:   { user: ['unfolded', 'scaffold'], agent: [] },
  unfolded:     { user: ['divergence'], agent: [] },
} as const
```

**An agent has no outgoing transition to `unfolded` from any tier.** This is the invariant
that enforces CLAUDE.md Section 1: no direct solution may ever reach the canvas without
the user explicitly asking. Tested exhaustively — from every starting tier below
`unfolded`, an agent move throws `IllegalTransitionError`.

CLAUDE.md speaks of "3 tiers" while this model has 5 states. They reconcile: Tier 0 is
`subconscious`; Tier 1 is `glow`; Tier 2 is the user's own progression through
`scaffold` → `divergence` → `unfolded`.

### 1c. StrokeNode (was missing — `ScaffoldingNode.targetNodeId` pointed at it)

```typescript
export interface StrokeNode extends BaseSpatialNode {
  type: 'stroke';
  /** Points along the pen path. Phase 2's Spatial VLM compiler reads these to
   *  reconstruct the derivation DAG rather than flattening it to OCR text. */
  points: Array<{ x: number; y: number }>; // at least 2
  pressure?: number[];
}
```

### 1d. Schema Validation

Nodes are validated with `zod` at the store boundary *before* entering the CRDT, so a
malformed record can never become load-bearing for every future peer. Bounds are
additionally refined to reject inverted boxes (`maxX < minX`), which would otherwise make
the R-Tree walk its entire structure (mourner/rbush#129) — a routine occurrence on an
infinite canvas during a fast pan.

### 1e. Open gaps still to close before Phase 1

- `DerivationEdge` — edges of the derivation DAG, distinct from layer assignment.
- Idempotency strategy for re-applying the same agent insight.
- Ordering rule for `zIndex` / parent-child stacking, which the canvas needs and the data
  model does not yet express.

## 2. Attention Arbiter State Machine

```typescript
export type FlowState = 'DEEP_WRITING' | 'HESITATION' | 'IDLE_STUCK' | 'INSPECTING';

export interface AttentionBudgetSnapshot {
  flowState: FlowState;
  lastStrokeTimestamp: number;
  consecutiveHesitationSeconds: number;
  canTriggerGlow: boolean; // True only if IDLE_STUCK or HESITATION > threshold
}
```

## 3. MCP Agent Mesh Schemas

### Verification Tool Input (`verify_derivation`)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "VerifyDerivationInput",
  "type": "object",
  "properties": {
    "context_steps": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Preceding mathematical steps in LaTeX format"
    },
    "current_step": {
      "type": "string",
      "description": "The target step to verify in LaTeX format"
    },
    "domain": {
      "type": "string",
      "enum": ["calculus", "linear_algebra", "discrete_math", "general"],
      "default": "calculus"
    }
  },
  "required": ["context_steps", "current_step"]
}
```

### Verification Tool Output (`verify_derivation`)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "VerifyDerivationOutput",
  "type": "object",
  "properties": {
    "is_valid": { "type": "boolean" },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "error_type": {
      "type": "string",
      "enum": ["none", "sign_error", "domain_violation", "invalid_substitution", "logic_gap"]
    },
    "socratic_prompt": {
      "type": "string",
      "description": "A probing question guiding the user to spot the mistake themselves"
    },
    "counterexample": {
      "type": "string",
      "description": "Minimal concrete counterexample where the step fails"
    }
  },
  "required": ["is_valid", "confidence", "error_type"]
}
```
