# Penumbra Architecture Specification

## 1. System Topology Overview

Penumbra operates as a 6-layer reactive ambient microkernel, replacing the standard Request-Response Chat model with a Decoupled Spatial State Machine.

```
┌─────────────────────────────────────────────────────────────┐
│ 6. Presentation Canvas (CanvasEngine adapter + DOM shapes)  │
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
- Isolation is **structural, not procedural**: `private_draft` lives in a separate `Y.Doc` instance, backed by its own IndexedDB database, which is never handed to a transport. Yjs offers no "serialise everything except this namespace" primitive — one transaction emits one merged byte array — so a runtime filter at a serialization boundary cannot be the guarantee. See ADR-002.
- A runtime `EgressPolicy` check remains as defence in depth, and an ESLint rule bans `fetch` outside `src/core/net/`.
- Hardware Kill-Switch: Global shortcut `Ctrl + Shift + Esc` immediately aborts active agent threads and unmounts all AI visual annotations.

### Layer 5: Spatial-Temporal CRDT Substrate

- Collaborative data store powered by Yjs. Concurrent writes from the user pen and background MCP agents resolve deterministically.
- Each layer is a **root type** (`doc.getMap('layer:human')`), not a nested map: root types encode more cheaply and items in different root types can never conflict.
- `rbush` 2D R-Tree provides viewport querying. **The published figure is the speedup
  ratio, not the milliseconds.** Measured at 10,000 nodes over a deterministic fixture
  (2,369 viewport matches): **6.4x** on the development machine, **3.5x** on a shared
  CI runner, against a brute-force linear scan measured in the same run. Absolute
  timings are machine-specific and have already failed to reproduce — the pair
  originally published here (`0.021 ms` / `0.162 ms`) did not reproduce on the second
  machine, which measured `0.049 ms` / `0.170 ms`. The gap is the point: a virtualised
  runner's cache behaviour compresses exactly the ratio a cache-favouring structure
  exists to exploit, which is why only the ratio is asserted and only the ratio is
  published. At 100,000 nodes p50 is 0.67 ms on the same machine. The earlier claim of
  "sub-millisecond over 100,000 nodes" was asserted without a measurement; these figures
  come from `pnpm test:perf`.
- The spatial index is split into two trees at the enclave boundary, because `rbush` stores items by reference and a single tree spanning that boundary would turn "mutated a node after insertion" into a privacy bug rather than a rendering bug (ADR-006).

### Layer 6: Presentation Canvas

- Reached through a `CanvasEngine` interface (`src/core/canvas/`), not bound to a single rendering library. `@tldraw/tldraw` was removed as a hard dependency: it is source-available but not open source, it requires a licence key for production, and its `LicenseManager` beacons `window.location.href` to `cdn.tldraw.com` with no opt-out — which cannot be prevented by any store-layer design and directly contradicts Layer 4. See ADR-001 and `docs/LICENSE-NOTES.md`.
- Custom shapes implement the scaffolding UI, split-comparison debate widgets, and dynamic WebGL parameter sliders.
