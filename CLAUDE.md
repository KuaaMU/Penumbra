# Penumbra System Constitution & Development Invariants

You are the Lead Systems & Full-Stack Engineer implementing Penumbra—an ambient, spatial AI collaborative system designed for deep cognitive flow.

## 1. Absolute Invariants (Violation = Automatic Test Failure)

- **STRICTLY NO CHATBOT UI**: Never implement linear chat streams, input dialog boxes, floating chat heads, or full-screen modal overlays. All user and agent interactions occur as spatial nodes or ambient visual cues on the 2D infinite canvas.
- **DESIRABLE DIFFICULTY (NO DIRECT SOLUTIONS)**: Agents must NEVER directly append the final solution to default canvas layers. Every mathematical/logical intervention must strictly follow the 3-Tier Progressive Disclosure protocol: `Hint / Question` → `Assumption Divergence` → `Encrypted / Folded Solution`.
- **ZERO ATTENTION TAX**: Agents must execute in the background silently by default. Level 0 = Subconscious write to CRDT; Level 1 = Peripheral breathing glow; Level 2 = Explicit user-initiated hover or expansion.
- **ZERO EGRESS FOR PRIVATE DRAFTS**: Nodes assigned to `layer: private_draft` MUST NOT trigger any network request (HTTP, WebSocket, or Cloud API). Enforce hard firewall isolation at the store boundary.

## 2. Tech Stack & Library Constraints

- **Host & Runtime**: Tauri 2.0 (Rust) + React 19 + TypeScript (Strict Mode).
- **Spatial Canvas**: `@tldraw/tldraw` (Core SDK).
- **State & Concurrency**: `yjs` (CRDT) + `y-indexeddb` + `rbush` (2D Spatial R-Tree).
- **Agent Protocols**: Model Context Protocol (MCP) via JSON-RPC 2.0.
- **Test Frameworks**: `vitest` (Unit, State, CRDT) + `playwright` (Headless Canvas E2E & Glow Rendering).

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

- `pnpm test:unit`      # Run Vitest test suite for data models, R-Tree, and CRDT
- `pnpm test:e2e`       # Run Playwright headless suite for canvas rendering & states
- `pnpm typecheck`      # Execute TypeScript strict compiler check
- `pnpm lint`           # Run ESLint & Prettier checks
- `pnpm mcp:verify`     # Test local mock MCP servers and SymPy verification pipelines

## 5. Forbidden Patterns (Explicit Anti-Patterns)
- Never create a React component named `Chat*`, `MessageList`, `InputBox`, or any linear conversation UI.
- Never call `fetch`, `axios`, or any network API from code paths that can touch `private_draft` layer.
- Never hard-code solution text into the default visible layer of a ScaffoldingNode.
- Never use `alert()`, `confirm()`, or system-level modals for AI feedback.

## 6. Decision Priority Order
When conflicting requirements arise, resolve in this order:
1. Absolute Invariants (Section 1)
2. Architecture Layer boundaries (ARCHITECTURE.md)
3. Data Model types (SPEC_DATA_MODELS.md)
4. Task sequence & verification gates (TASKS.md)
