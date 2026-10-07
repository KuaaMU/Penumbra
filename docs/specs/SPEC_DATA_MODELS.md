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
  version: number;
  createdAt: number;
  layer: LayerType;
  bounds: BoundingBox2D;
  visibility: VisibilityLevel;
  confidence: number; // 0.0 to 1.0
  author: 'user' | 'agent_proposer' | 'agent_skeptic' | 'agent_distiller';
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
