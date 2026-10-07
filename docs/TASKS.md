# Penumbra Phased Implementation & Verification Backlog

This document defines the strict, sequential test-driven work packages for Claude Code. Do not advance to subsequent phases until the current phase's verification gates pass.

---

## Phase 0: Workspace Scaffold, CRDT Store & Spatial Engine

### Task 0.1: Project Setup & Quality Tooling

- **Action**: Initialize a Vite + React + TypeScript application with TailwindCSS and Tauri 2.0 shell config.
- **Verification Gate**: `pnpm build`, `pnpm typecheck`, `pnpm lint` pass with zero warnings.

### Task 0.2: Yjs Multi-Layer Data Store

- **Action**: Implement `CanvasStore` wrapping a `Y.Doc`. Support 4 segregated layers (`human`, `agent_annotation`, `agent_debate`, `private_draft`).
- **Tests (Vitest)**:
  - `tests/unit/crdt_layers.test.ts`: Test that two simulated clients can insert nodes concurrently into different layers without conflict.
  - `tests/unit/enclave_guard.test.ts`: Test that queries targeting cloud sync throw an error when accessing `private_draft` nodes.

### Task 0.3: R-Tree Spatial Indexing Pipeline

- **Action**: Integrate `rbush` with the CRDT node lifecycle. Index all nodes by 2D bounding boxes.
- **Tests (Vitest)**:
  - `tests/unit/spatial_index.test.ts`: Insert 10,000 randomized nodes. Assert bounding box query around viewport `[0, 0, 1920, 1080]` returns exact matches in under 3ms.

---

## Phase 1: Canvas Integration & 3-Tier Scaffolding Node

### Task 1.1: Custom Shape Registration in tldraw

- **Action**: Register `ScaffoldingShape` in `@tldraw/tldraw`.
- **Tests (Playwright E2E)**:
  - `tests/e2e/scaffolding_shape.test.ts`: Render canvas headless. Mount a `ScaffoldingShape`. Validate DOM presence.

### Task 1.2: Three-Tier State Machine & Glow Rendering

- **Action**: Implement CSS breathing glow for `visibility: 'glow'`. Implement pointer click handling for progressive disclosure (`glow` → `scaffold` → `divergence` → `unfolded`).
- **Tests (Playwright E2E)**:
  - `tests/e2e/progressive_disclosure.test.ts`:
    1. Assert node in `glow` state renders zero direct solution text.
    2. Click once: assert `socraticHint` is visible in DOM.
    3. Click detail toggle: assert `divergenceMatrix` is visible.
    4. Assert `unfoldedSolution` is only unmasked after third explicit click.

---

## Phase 2: PDF Ingestion & Spatial Slicing

### Task 2.1: PDF Clipping to Canvas Node

- **Action**: Integrate PDF.js viewer pane with lasso selection. Export bounding-box crop to `PDFSnippetNode`.
- **Tests (Vitest + Playwright)**:
  - `tests/unit/pdf_snippet.test.ts`: Verify snippet serialization with source document hash, page index, and coordinate mapping.
  - `tests/e2e/pdf_slice_anchor.test.ts`: Click snippet on canvas; assert PDF viewer navigates to matching page and coordinates.

---

## Phase 3: Attention Arbiter & Flow Detection

### Task 3.1: Flow State Engine

- **Action**: Implement `FlowDetector` class measuring user stroke intervals and cursor activity.
- **State Table**:
  - Continuous strokes (< 3s gap) → `DEEP_WRITING`
  - Inactivity between 3s and 15s → `HESITATION`
  - Inactivity > 15s → `IDLE_STUCK`
- **Tests (Vitest)**:
  - `tests/unit/flow_detector.test.ts`: Feed mocked time-series user events. Assert expected `FlowState` transitions.

---

## Phase 4: Local Mathematical Verification via MCP Mock

### Task 4.1: SymPy Verification Harness

- **Action**: Implement an MCP Client connecting to a local Python script running SymPy.
- **Tests (Integration / CLI)**:
  - `tests/integration/sympy_mcp.test.ts`:
    - Feed: `\int x dx = \frac{1}{2}x^2 + C` → Returns `is_valid: true`.
    - Feed: `\int_0^\pi \sin(x) dx = 0` → Returns `is_valid: false`, `error_type: "sign_error"`, and a Socratic prompt.
