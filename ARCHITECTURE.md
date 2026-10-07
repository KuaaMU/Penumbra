# Penumbra Architecture Specification

## 1. System Topology Overview

Penumbra operates as a 6-layer reactive ambient microkernel, replacing the standard Request-Response Chat model with a Decoupled Spatial State Machine.

```
┌─────────────────────────────────────────────────────────────┐
│ 6. Presentation Canvas (tldraw SDK + Custom Shapes + WebGL) │
├─────────────────────────────────────────────────────────────┤
│ 5. Spatial-Temporal Substrate (Yjs CRDT + rbush 2D R-Tree) │
├─────────────────────────────────────────────────────────────┤
│ 4. Trust & Enclave Layer (Zero-Egress Draft + Kill-Switch) │
├─────────────────────────────────────────────────────────────┤
│ 3. Agent Mesh (MCP Bus + Proposer-Skeptic-Distiller Engine) │
├─────────────────────────────────────────────────────────────┤
│ 2. Attention Arbiter (Flow Detector + 3-Tier State Machine) │
├─────────────────────────────────────────────────────────────┤
│ 1. Perception & Ingestion (PDF Slicer + Multimodal VLM AST) │
└─────────────────────────────────────────────────────────────┘
```

## 2. Layer Definitions

### Layer 1: Multimodal Perception & Ingestion

- **PDF Spatial Pinning**: Extracts vector layers and bounding boxes via PDF.js. Allows arbitrary lasso clipping of theorems, charts, and formulas. Generates `PDFSnippetNode` with bi-directional coordinate deep links back to source files.
- **Spatial VLM Compiler**: Treats user strokes not as flat OCR text, but as a directed acyclic graph (DAG) of mathematical and logical derivations, preserving arrows, strikes, and 2D spatial layouts.

### Layer 2: Intent & Attention Arbiter

- **Flow State Estimator**: Analyzes interaction metrics (stroke cadence, pointer hesitation, viewport idle time) to compute `FlowBudget`.
- **Three-Tier Projection Pipeline**:
  - `Level 0 (Subconscious)`: Agent computation completes and registers into CRDT state silently (`alpha = 0`).
  - `Level 1 (Peripheral Glow)`: High-confidence flaw detected + user enters hesitation state (`idle > 15s`). Renders a 0.5Hz subtle CSS luminescence around the target bounding box.
  - `Level 2 (Scaffolding Drawer)`: Triggered ONLY on user pointer hover or touch tap. Progressive Disclosure: Step 1 (Socratic Query) → Step 2 (Assumption Divergence Matrix) → Step 3 (Encrypted Full Derivation).

### Layer 3: Agent Mesh (Execution Engine)

- **MCP Native**: All external tools (SymPy, Lean 4, Web Search) and internal agent nodes expose standard Model Context Protocol schemas.
- **Adversarial Convergence Protocol (Proposer ⟷ Skeptic ⟷ Distiller)**:
  - `Proposer`: Derives prospective next steps.
  - `Skeptic`: Adversarial unit tasked strictly with generating counterexamples and edge-case contradictions.
  - `Distiller`: Compresses debate logs into a 3-line comparative decision matrix.

### Layer 4: Trust & Isolation Enclave

- Hard network boundary isolation between layers. Nodes tagged with `layer: "private_draft"` cannot be read by cloud dispatchers.
- Hardware Kill-Switch: Global shortcut `Ctrl + Shift + Esc` immediately aborts active agent threads and unmounts all AI visual annotations.

### Layer 5: Spatial-Temporal CRDT Substrate

- Collaborative data store powered by Yjs. Concurrent writes from the user pen and background MCP agents resolve deterministically.
- `rbush` 2D R-Tree provides sub-millisecond bounding box collision and viewport querying over 100,000+ nodes.

### Layer 6: Presentation Canvas

- Built on `@tldraw/tldraw`. Custom shapes implement the scaffolding UI, split-comparison debate widgets, and dynamic WebGL parameter sliders.
