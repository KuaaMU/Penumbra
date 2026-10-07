# Penumbra Phased Implementation & Verification Backlog

This document defines the strict, sequential test-driven work packages for Claude Code. Do not advance to subsequent phases until the current phase's verification gates pass.

---

## Phase 0: Workspace Scaffold, CRDT Store & Spatial Engine

> **Status: COMPLETE** — see `docs/ADR/ADR-001-through-006.md`. Gates green:
> `pnpm build`, `pnpm typecheck`, `pnpm lint` (0 warnings), `pnpm test:unit` (99 passing,
> 2 perf skipped), `pnpm test:e2e` (2 passing), `pnpm test:perf` (2 passing, measured).

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
- **Deviation from the original gate**: the spec asked for "under 3ms". Measured on this machine: R-Tree p50 **0.025 ms**, brute force p50 **0.161 ms** (**6.4x**; 3.5x on a shared CI runner) — a 3 ms budget passes a completely broken index and a no-index scan alike, so it cannot fail for any realistic defect. The mandatory gate in `test:unit` is therefore *correctness*; the timing assertion moved to `pnpm test:perf` behind `PENUMBRA_PERF=1` and carries a machine-independent ratio assertion, `bruteP50 / p50 > 2` (`REQUIRED_SPEEDUP` in
`tests/perf/spatial_index.perf.test.ts`). See ADR-003.

**Published figures are a ratio, not a pair of milliseconds.** Absolute timings are
machine-specific and have already failed to reproduce: the numbers first published here
(`0.021 ms` / `0.162 ms` / `7.6x`) did not reproduce on a second machine, which measured
`0.049 ms` / `0.170 ms` / `3.5x`. Only the ratio survives a hardware change, so only the
ratio is asserted and only the ratio is published.

---

## Phase 1: Canvas Integration & 3-Tier Scaffolding Node

> **Re-cut 2026-10-08.** The tasks below were written when `@tldraw/tldraw` was the
> mandated canvas. ADR-001 removed it, so the original gates were unmeetable rather than
> merely unmet — they instructed an implementer to register a shape in a library the
> constitution forbids. Task 1.1 is re-cut against the `CanvasEngine` seam in Phase 1.1a
> of the Phase 1 plan (ADR-007).

### Task 1.0: Harden the mutation seam — COMPLETE

`CanvasStore.update()` enforced none of the invariants `setVisibility` enforced. Across the
entire Phase 0 suite there was exactly ONE `update()` call, patching `{bounds}` — which is
why four bypasses shipped green. Measured reproductions, all against unmodified Phase 0:

| defect | effect |
|---|---|
| `layer` is writable through a patch | a `private_draft` patched to `layer:'human'` lands in `Y.encodeStateAsUpdate(doc)`; `exportable()` returns it; the enclave boundary holds in letter and fails in purpose |
| `visibility` is writable through a patch | `update(id, {visibility:'unfolded'}, 'agent')` succeeds where `setVisibility` throws — the ZERO ATTENTION TAX invariant, bypassable from the public API |
| `insert()` never consults the transition table | an agent authors a node born at `unfolded`, carrying the finished solution, without ever passing the table |
| `#emit` routes removals through `getNodeById` | `remove()` emits `{nodes: []}`; a consumer rebuilding from events cannot tell a deletion from an empty layer |

Fixed in `tests/unit/store_invariants.test.ts` (36 tests, all four defects reproduced and
refused) and `tests/unit/index_sync.test.ts`. Also closed: `remove()`/`update()` on a
tombstoned record, writes after `destroy()`, and the fact that `getNode()` handed out the
stored object by reference — which let any caller rewrite the document through a node it
merely read, with no transaction and therefore none of `update()`'s checks.

### Task 1.1: The renderer

- **Action**: implement `CanvasEngine` (`src/core/canvas/engine.ts`) over positioned DOM
  elements and one transformed world container. No canvas, no WebGL, no third-party
  renderer dependency in Phase 1. Rationale and the measured licence/status evidence for
  the rejected options are in ADR-007.
- **Tests (Playwright E2E)**:

### Task 1.2: Three-Tier State Machine & Glow Rendering

- **Action**: Implement CSS breathing glow for `visibility: 'glow'`. Implement pointer click handling for progressive disclosure (`glow` → `scaffold` → `divergence` → `unfolded`).
- **Tests (Playwright E2E)**:
  - `tests/e2e/progressive_disclosure.test.ts`:
    1. Assert node in `glow` state renders zero direct solution text.
    2. Click once: assert `socraticHint` is visible in DOM.
    3. Click detail toggle: assert `divergenceMatrix` is visible.
    4. Assert `unfoldedSolution` is only unmasked after third explicit click.

  **Correction, added after the four assertions above were written.** Those four are
  satisfiable by a renderer that does nothing: assertion 1 passes when no node is
  mounted at all, and assertions 2-4 pass only if a node *is* mounted — so the suite
  measures the renderer twice and catches neither failure mode cleanly. Measured in a
  headless browser: `expect(locator).toHaveCount(0)` resolves in **7 ms** against an
  element that appears at 800 ms, so a "nothing is rendered" assertion is vacuous by
  default; `toBeHidden()` passes on a `display:none` node; and a viewport-scoped
  `not.toContainText` cannot fail at all — it passes against a dead renderer, against
  an `aria-label` leak, and against a `data-*` leak.

  So each negative assertion is written to be un-passable without a live node:

  - a `data-testid="scene-ready"` anchor emitted on the engine's first commit, and every
    negative assertion waits for it first;
  - `toHaveCount(0)` only, never `toBeHidden()`;
  - four independent leak detectors for "a `glow` node carries no solution text", each
    with its own positive control (inject the sentinel, prove that detector finds it,
    remove it) — node-scoped text, `document.body.textContent`, an attribute sweep, and
    a comment-node `createTreeWalker`;
  - a `MutationObserver` recording the `data-visibility` sequence, so a renderer that
    jumps `glow -> unfolded` in one click fails even though it satisfies all four
    literal assertions above;
  - the "absent before the third click" half is always paired with "present after it",
    because absence alone is what a permanently-hidden renderer produces.

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
