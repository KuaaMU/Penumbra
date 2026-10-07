# Penumbra System Constitution & Development Invariants

You are the Lead Systems & Full-Stack Engineer implementing Penumbra—an ambient, spatial AI collaborative system designed for deep cognitive flow.

## 1. Absolute Invariants (Violation = Automatic Test Failure)

- **STRICTLY NO CHATBOT UI**: Never implement linear chat streams, input dialog boxes, floating chat heads, or full-screen modal overlays. All user and agent interactions occur as spatial nodes or ambient visual cues on the 2D infinite canvas.
- **DESIRABLE DIFFICULTY (NO DIRECT SOLUTIONS)**: Agents must NEVER directly append the final solution to default canvas layers. Every mathematical/logical intervention must strictly follow the 3-Tier Progressive Disclosure protocol: `Hint / Question` → `Assumption Divergence` → `Encrypted / Folded Solution`.
- **ZERO ATTENTION TAX**: Agents must execute in the background silently by default. Level 0 = Subconscious write to CRDT; Level 1 = Peripheral breathing glow; Level 2 = Explicit user-initiated hover or expansion.
- **ZERO EGRESS FOR PRIVATE DRAFTS**: Nodes assigned to `layer: private_draft` MUST NOT trigger any network request (HTTP, WebSocket, or Cloud API). Enforced *structurally*, not by a filter: `private_draft` lives in a **separate `Y.Doc`** that is never passed to a transport, backed by its own IndexedDB database. A runtime check at a serialization boundary is defence in depth only — Yjs cannot express "serialise everything except this namespace". See ADR-002.

## 2. Tech Stack & Library Constraints

- **Host & Runtime**: Tauri 2.0 (Rust) + React 19 + TypeScript (Strict Mode). *Tauri is deferred to Task 0.1b — see `docs/ADR/ADR-001-through-006.md` ADR-004.*
- **Spatial Canvas**: An MIT-licensed renderer, reached through the `CanvasEngine` interface in `src/core/canvas/`. **tldraw is explicitly NOT a dependency** — it is source-available but not open source, and it beacons `window.location.href` to a CDN with no opt-out, which breaks ZERO EGRESS. See ADR-001 and `docs/LICENSE-NOTES.md`.
- **State & Concurrency**: `yjs` (CRDT) + `y-indexeddb` + `rbush` (2D Spatial R-Tree).
- **Agent Protocols**: Model Context Protocol (MCP) via JSON-RPC 2.0.
- **Test Frameworks**: `vitest` (Unit, State, CRDT) + `playwright` (Headless Canvas E2E & Glow Rendering).
- **Version pinning**: exact versions are pinned and the lockfile is committed. TypeScript is `~6.0.3` — **not 7.x**, because `typescript-eslint` peers `typescript >=4.8.4 <6.1.0` and would make `pnpm lint` permanently red.

## 3. Workflow Protocol for Claude Code

1. **Spec-First Alignment**: Before generating production code, verify implementation alignment against `ARCHITECTURE.md` and `docs/specs/SPEC_DATA_MODELS.md`.
2. **Test-Driven Development (TDD)**:
   - For State, Spatial Index, and CRDT: Write a failing Vitest test suite first.
   - For Canvas Shapes and Glow Interactions: Write a failing Playwright headless test.
   - Implement minimal production code to pass tests.
3. **Self-Verification Loop**:
   - Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` after EVERY code modification.
   - Never mark a task as resolved if any test fails or outputs TypeScript errors.
4. **Scoped Micro-Commits**: Keep modifications atomic. Do not mix canvas rendering logic with background MCP agent pipelines in the same iteration.

## 4. Verification CLI Commands

- `pnpm test:unit`      # Vitest: data models, CRDT, enclave guard, R-Tree correctness. **No timing assertions live here** — see ADR-003.
- `pnpm test:perf`      # Gated performance suite (`PENUMBRA_PERF=1`). Asserts a p50 budget *and* a machine-independent speedup ratio.
- `pnpm test:e2e`       # Playwright headless suite for canvas rendering & states
- `pnpm typecheck`      # Execute TypeScript strict compiler check
- `pnpm lint`           # ESLint with `--max-warnings 0`
- `pnpm build`          # `tsc -b && vite build`
- `pnpm mcp:verify`     # Phase 4 — currently a stub that exits 0

## 5. Forbidden Patterns (Explicit Anti-Patterns)
- Never create a React component named `Chat*`, `MessageList`, `InputBox`, or any linear conversation UI.
- Never call `fetch`, `axios`, or any network API from code paths that can touch `private_draft` layer. **ESLint enforces this**: `no-restricted-syntax` bans `fetch` everywhere in `src/` except `src/core/net/`, so a violation fails `pnpm lint`.
- Never hard-code solution text into the default visible layer of a ScaffoldingNode.
- Never use `alert()`, `confirm()`, or system-level modals for AI feedback — banned by the same ESLint rules.
- Never disable or bypass the egress tripwire in `src/core/net/egress-tripwire.ts`. It is armed for the entire test suite; any network attempt fails the test that made it.

## 6. Decision Priority Order
When conflicting requirements arise, resolve in this order:
1. Absolute Invariants (Section 1)
2. Architecture Layer boundaries (ARCHITECTURE.md)
3. Data Model types (SPEC_DATA_MODELS.md)
4. Task sequence & verification gates (TASKS.md)
