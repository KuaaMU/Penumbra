# Penumbra Phased Implementation & Verification Backlog

This document defines the strict, sequential test-driven work packages for Claude Code. Do not advance to subsequent phases until the current phase's verification gates pass.

---

## Phase 0: Workspace Scaffold, CRDT Store & Spatial Engine

> **Status: COMPLETE** — see `docs/ADR/ADR-001-through-006.md`. Gates green:
> `pnpm build`, `pnpm typecheck`, `pnpm lint` (0 warnings), `pnpm test:unit` (42 passing),
> `pnpm test:e2e` (2 passing), `pnpm test:perf` (2 passing, measured).

### Task 0.1: Project Setup & Quality Tooling

- **Action**: Initialize a Vite + React + TypeScript application with TailwindCSS. Tauri is deferred to 0.1b.
- **Verification Gate**: `pnpm build`, `pnpm typecheck`, `pnpm lint` pass with zero warnings.
- **Delivered**: Vite 8.3.3 · React 19.3 · TS **6.0.3** (not 7.x — `typescript-eslint` peers `<6.1.0`, so TS 7 would leave `pnpm lint` permanently red) · Tailwind 4.3.3 via the Vite plugin · ESLint 10 flat config · Vitest 5 (`unit` + `perf` projects) · Playwright 1.63.

### Task 0.1b: Tauri 2.0 Host Shell — NOT STARTED

- **Action**: `src-tauri` scaffold, `pnpm tauri dev/build`.
- **Why deferred**: Tasks 0.2/0.3 are pure TypeScript. Keeping cargo/MSVC/WebView2 out of the first gate removes the slowest and least deterministic variable from every verification loop.
- **Verification Gate**: `pnpm tauri build` passes.

### Task 0.2: Yjs Multi-Layer Data Store — COMPLETE

- **Action**: `CanvasStore` wrapping `Y.Doc`. 4 layers; `private_draft` in a **separate** `Y.Doc` (ADR-002). Layer authority matrix, visibility transition table, zod validation, tombstones.
- **Tests (Vitest)**: `tests/unit/crdt_layers.test.ts` (concurrent multi-layer convergence, byte-level convergence with an anti-tautology pre-merge divergence guard, idempotent replay, authority refusals) · `tests/unit/enclave_guard.test.ts` (the three-part falsifiable egress suite from ADR-005).

### Task 0.3: R-Tree Spatial Indexing Pipeline — COMPLETE

- **Action**: `SpatialIndex` over `rbush`, split into `worldTree` / `privateTree` at the enclave boundary, synced from `CanvasStore`.
- **Tests (Vitest)**: `tests/unit/spatial_index.test.ts` — exact set-equality against a brute-force reference over 10,000 nodes and 30 query boxes, using rbush's own **inclusive-edge** intersection predicate.
- **Deviation from the original gate**: the spec asked for "under 3ms". Measured: R-Tree p50 **0.021 ms**, brute force p50 **0.162 ms** — a 3 ms budget passes a completely broken index and a no-index scan alike, so it cannot fail for any realistic defect. The mandatory gate in `test:unit` is therefore *correctness*; the timing assertion moved to `pnpm test:perf` behind `PENUMBRA_PERF=1` and carries a machine-independent ratio assertion (`p50 * 5 < bruteP50`). See ADR-003.

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
