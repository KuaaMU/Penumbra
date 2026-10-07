# Contributing to Penumbra

Penumbra is an ambient, spatial AI system. There is no chat UI, and contributions that
introduce one will be rejected regardless of how good they are otherwise.

## The three rules

These are enforced in code and in CI, not merely documented:

1. **No direct solutions.** An agent may never move a node to `unfolded`. The visibility
   transition table in `src/core/model/nodes.ts` gives agents no outgoing transition to
   it, and `tests/unit/crdt_layers.test.ts` asserts this for every starting tier. If your
   change makes `unfolded` reachable without user intent, it is a bug, not a feature.

2. **No attention tax.** Agents write at Tier 0 without rendering. Anything the user did
   not ask for must not animate, pulse, scroll, or steal focus.

3. **No egress from `private_draft`.** Draft nodes live in a separate `Y.Doc` that is
   never handed to a transport. The global tripwire in `src/core/net/egress-tripwire.ts`
   is armed for the entire test suite: any `fetch`/`XHR`/`WebSocket`/`EventSource`/
   `sendBeacon` call fails the test that made it.

## Before you open a pull request

```bash
pnpm typecheck    # TS strict; must be clean
pnpm lint         # --max-warnings 0
pnpm test:unit    # no timing assertions here — by design
pnpm test:perf    # if you touched spatial indexing
pnpm test:e2e     # if you touched rendering
```

## Adding a dependency

New dependencies must be permissively licensed (MIT, Apache-2.0, BSD) and must be added
to `docs/LICENSE-NOTES.md` in the same pull request.

`tldraw` is explicitly not permitted as a hard dependency. It is source-available but not
open source, and its `LicenseManager` beacons `window.location.href` to a CDN with no
opt-out — which no amount of store-layer design can prevent, and which breaks rule 3.
See `docs/ADR/ADR-001-through-006.md`.

## Writing tests that are worth having

The Phase 0 suite was built adversarially; a few conventions came out of that:

- **Assert something that can fail.** A test comparing a value to itself passes forever.
  The CRDT convergence tests assert that two peers *diverge* before merging, precisely so
  the convergence assertion cannot pass vacuously.
- **Match the library's edge semantics.** `rbush`'s intersection test is inclusive on every
  edge, so a brute-force reference written with strict `<`/`>` fails on boxes that merely
  touch — a test suite lying to itself.
- **Pair a negative assertion with a positive control.** The egress content test asserts the
  sentinel string *is* findable in the local payload, so "not found in the outbound payload"
  means something.
- **Keep timing out of `test:unit`.** A perf budget that a busy CI runner can perturb is a
  budget that eventually gets ignored. See ADR-003.

## Architecture

Read `ARCHITECTURE.md` for the six layers and `docs/ADR/` for the decisions behind them.
When two requirements conflict, resolve in the order set out in `CLAUDE.md` Section 6.
