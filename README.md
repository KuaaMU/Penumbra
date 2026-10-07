# Penumbra

An ambient, spatial AI collaborative system designed for deep cognitive flow.

There is no chat window. There is no message list. There is no input box. Every
interaction — the user's and the agents' — is a node on an infinite 2D canvas, and
every answer arrives only as far as you asked it to.

## Status

**Phase 0 complete.** The CRDT substrate, the isolation enclave, and the spatial
index are implemented, tested, and documented. There is no canvas rendering yet —
`src/App.tsx` mounts an empty plane on purpose, because Phase 1 owns rendering.

| Gate | Result |
|---|---|
| `pnpm typecheck` | clean, TS strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| `pnpm lint` | clean at `--max-warnings 0` |
| `pnpm test:unit` | 48 passing |
| `pnpm test:e2e` | 2 passing (headless Chromium) |
| `pnpm test:perf` | 2 passing (gated behind `PENUMBRA_PERF=1`) |
| `pnpm build` | clean |

## Why this isn't a chatbot

Three rules are enforced in code, not just documented:

1. **No direct solutions.** An agent may never move a node to `unfolded`. The
   visibility transition table (`src/core/model/nodes.ts`) gives agents no outgoing
   transition to it from any tier, and the rule is tested exhaustively. The solution
   reaches the canvas only through three escalating user gestures:
   `glow → scaffold → divergence → unfolded`.

2. **No attention tax.** Agents write to the CRDT at Tier 0 without rendering
   anything. A high-confidence flaw plus a stalled user produces a 0.5 Hz breathing
   glow — and a glow carries no content, only an invitation.

3. **No egress from private drafts.** `private_draft` nodes live in a *separate
   `Y.Doc`* that is never handed to a transport. This is structural rather than
   procedural, because Yjs has no "serialise everything except this namespace"
   primitive — one transaction emits one merged byte array, so no filter at a
   serialization boundary could do it. An ESLint rule bans `fetch` outside
   `src/core/net/`, and a tripwire over `fetch`/`XHR`/`WebSocket`/`EventSource`/
   `sendBeacon` is armed for the entire test suite.

## Decisions

`docs/ADR/ADR-001-through-006.md` records the six decisions that shaped Phase 0, each
with the finding that forced it. The two that most affect what you read here:

- **ADR-001 — tldraw was removed.** It is source-available but not open source, it
  requires a licence key to run in production, and its `LicenseManager` beacons
  `window.location.href` to a CDN with no opt-out. That last point alone is
  disqualifying: the call originates inside the renderer's component tree, so no
  store-layer design can prevent it. The canvas is now reached through a
  `CanvasEngine` interface instead. Details and the full licence analysis:
  [`docs/LICENSE-NOTES.md`](docs/LICENSE-NOTES.md).

- **ADR-003 — the R-Tree gate measures correctness, not latency.** The original spec
  asked for a query under 3 ms. Measured: R-Tree p50 **0.021 ms**, brute-force linear
  scan p50 **0.162 ms**. A 3 ms budget therefore passes a completely broken index and
  a no-index scan alike, and tolerates a ~300x regression — it cannot fail for any
  realistic defect. The mandatory gate is now set-equality against a brute-force
  reference; the timing assertion moved behind `PENUMBRA_PERF=1` and carries a
  machine-independent ratio check.

## Getting started

```bash
pnpm install
pnpm dev            # Vite dev server
pnpm test:unit      # fast, no timing assertions
pnpm test:perf      # the gated performance suite
pnpm test:e2e       # headless Chromium
```

Requires Node ≥ 20.19 and pnpm 11. TypeScript is pinned to `~6.0.3`, **not** 7.x:
`typescript-eslint` peers `typescript >=4.8.4 <6.1.0`, so pinning 7 would leave
`pnpm lint` permanently red.

## Layout

```
src/core/model/      data model, layer authority, visibility transition table
src/core/store/      CanvasStore (two Y.Docs), egress policy, enclave
src/core/spatial/    SpatialIndex over rbush, split at the enclave boundary
src/core/canvas/     CanvasEngine interface — the swappable renderer seam
src/core/net/        egress tripwire; the only place network globals are named
tests/unit/          CRDT, enclave, spatial index, projection — no timing gates
tests/perf/          gated performance suite
tests/e2e/           headless canvas surface
```

## Licence

MIT — see [`LICENSE`](LICENSE) and [`docs/LICENSE-NOTES.md`](docs/LICENSE-NOTES.md).
