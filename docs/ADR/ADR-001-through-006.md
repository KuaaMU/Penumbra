# Architecture Decision Records

Every decision that constrains the system, and the reason it was made. New ADRs are
appended; superseded ones are marked, never deleted.

---

## ADR-001 — tldraw is removed from the mandatory stack; the canvas is reached through an adapter

**Status:** Accepted · 2026-10-08 · Blocks Tasks 0.1, 1.1

**Context.** `CLAUDE.md` Section 2 mandated `@tldraw/tldraw` as the canvas SDK. Three
findings, each verified against primary sources rather than documentation:

1. **It is not open source, and there is no revenue threshold.** `npm view @tldraw/tldraw license`
   returns the literal string `SEE LICENSE IN LICENSE.md`, not an SPDX identifier — this is
   how npm scanners detect non-OSS. The LICENSE grants only *"Use the Software in Development
   Environments"* and requires *"Not to use the Software in Production Environments."* A
   word-boundary search for `revenue`/`threshold`/`ARR`/`USD` returns **zero** matches: the
   trigger is an environment test (`getIsDevelopment()` treats `.localhost`, `http:`, and
   loopback as development; everything else requires a key), not a financial one.
   tldraw's own words: *"any source code or packages covered by the tldraw SDK license
   would not be Open Source by any definition."*

2. **It fires an unconditional telemetry beacon that leaks `window.location.href`.**
   `LicenseManager.maybeTrack()` builds
   `https://cdn.tldraw.com/watermarks/watermark-track.svg?version=…&license_type=…&url=<window.location.href>`
   and calls `fetch(...)`. `getTrackType()` returns non-null for `unlicensed-production`,
   `evaluation`, and `licensed-with-watermark` — i.e. it fires for anyone without a
   paid key. **This is unreachable from our store boundary**: the call originates inside
   the renderer's own component tree. Our constitution's second absolute invariant is
   ZERO EGRESS for `private_draft`; a beacon inside the canvas renderer cannot be
   firewalled by any CRDT design. There is no opt-out flag in the codebase.

3. **Every downstream user of an OSS Penumbra would need their own paid licence key**,
   or the app renders an `UnlicensedWatermark` button and — past a 5-second licence
   timeout — stops rendering at all.

**Decision.** Drop the hard tldraw dependency. Define a `CanvasEngine` interface in
`src/core/canvas/`, implement it once over a permissively-licensed renderer, and keep
tldraw reachable only as an optional, off-by-default adapter that is never a
`dependencies` entry.

**Consequences.** `CLAUDE.md` Section 2 and `ARCHITECTURE.md` Layer 6 are amended. Phase 1
gains an adapter seam. The alternative — keeping tldraw — was rejected because finding (2)
alone is disqualifying: it contradicts an absolute invariant, and no amount of store-layer
design can prevent a `fetch()` inside a third-party component.

---

## ADR-002 — `private_draft` lives in a physically separate `Y.Doc`, not a layer inside one document

**Status:** Accepted · 2026-10-08 · Blocks Task 0.2

**Context.** The obvious reading of the spec is one `Y.Doc` with four `Y.Map` layers, plus a
runtime guard that refuses to serialise `private_draft`. Adversarial verification refuted
that this can be *structural*:

- yjs emits **one merged `Uint8Array` per transaction** via `doc.emit('update', …)` after
  `writeUpdateMessageFromTransaction`. A single `transact()` touching two layers produces
  one update carrying no per-layer metadata — a boundary guard cannot see or strip a layer
  from it.
- `Y.encodeStateAsUpdate(doc, stateVector)` filters **only** by per-client clock. There is
  no layer or namespace filter anywhere in the encoding path; `diffUpdate`/`mergeUpdates`
  are likewise client-vector based. **Yjs offers no "serialise everything except X" primitive.**
- `y-indexeddb` subscribes to `doc.on('update')` and calls whole-document
  `Y.encodeStateAsUpdate` — so a shared doc persists draft bytes into IndexedDB.
- Subdocuments (`ContentDoc`) integrate into the **parent's** update and sync with the
  parent's provider, so a draft subdoc is not isolated either.

**Decision.** `private_draft` is a **separate `Y.Doc` instance**, in a separate IndexedDB
database, that is never passed to a provider. The three shareable layers
(`human`, `agent_annotation`, `agent_debate`) share one doc. Layer isolation becomes a
property of the object graph rather than of a runtime check that someone can forget.

The runtime guard is kept as **defence in depth**, not as the primary mechanism.

**Consequences.** Tests must assert on *object-graph* separation (the draft doc is never an
argument to any encoder) plus a behavioural tripwire, not on a payload filter.

---

## ADR-003 — The R-Tree gate is correctness, not latency

**Status:** Accepted · 2026-10-08 · Blocks Task 0.3

**Context.** `TASKS.md` Task 0.3 requires "under 3 ms". Measured on real rbush 4.0.1 at
10,000 items: p50 ≈ 0.009 ms, while a **brute-force linear scan of the same data takes
0.047 ms** — still 60× under budget. The gate therefore passes for a completely broken
index, for a no-index scan, and for a 100× regression. It cannot fail for any realistic
defect, so it is a rubber stamp that reads as a guarantee.

**Decision.** Two assertions, and they test different things:
1. **Mandatory, in `pnpm test:unit`** — exact set-equality against a brute-force reference,
   using rbush's own inclusive-edge intersection predicate, with a non-vacuity guard. This
   is the assertion with teeth.
2. **Gated behind `PENUMBRA_PERF=1`** — a p50 budget *plus* a machine-independent **ratio**
   assertion (`bruteForceP50 / p50 > 2`) that is immune to a slow machine.

   *Corrected 2026-10-08.* This ADR previously read `p50 * 5 < bruteForceP50`. The
   shipped constant is `REQUIRED_SPEEDUP = 2` in `tests/perf/spatial_index.perf.test.ts`
   — i.e. `bruteP50 / p50 > 2`, a bound **2.5x looser** than this document claimed. An
   ADR that describes a stricter threshold than the one that runs is worse than no
   threshold: a reviewer reading the ADR believes a 5x gate protects the index, and no
   test would contradict them.

Additionally, a **dense-viewport** case is required: the spec's own setup
(`[0,0,1920,1080]` over uniform random nodes) hits only ~57 of 10,000 nodes, so the tree
is barely exercised. Vitest fake timers freeze `performance.now()` *and* `Date.now()`, which
silently turns any timing assertion green forever — the perf test asserts p50 > 0 so a frozen
clock fails loudly.

**Consequences.** `ARCHITECTURE.md`'s "sub-millisecond over 100,000 nodes" claim is restated
to the measured figure; nothing measures 100k yet.

---

## ADR-004 — Toolchain pins, and the TypeScript version trap

**Status:** Accepted · 2026-10-08 · Blocks Task 0.1

**Decision.** Pin exact versions; commit the lockfile.

| Package | Pin | Why |
|---|---|---|
| `typescript` | `~6.0.3` | **Not 7.0.2.** `typescript-eslint@8.71.1` declares peer `typescript: ">=4.8.4 <6.1.0"` and throws a module-load error against TS 7. The constitution makes `pnpm lint` a release gate — pinning TS 7 makes that gate permanently red. |
| `eslint` | `~10.12.0` | ESLint 10 is GA; both plugins already peer-allow `^10.0.0`. Flat config only. |
| `vite` / `vitest` | `~8.3.3` / `~5.0.3` | Matched pair; vitest 5 peers `^6.4.0 \|\| ^7 \|\| ^8`. |
| `tailwindcss` + `@tailwindcss/vite` | `~4.3.3` | Must be exact-matched. Use the **Vite plugin**, not PostCSS. |
| `rbush` + `@types/rbush` | `~4.0.1` / `~4.0.0` | rbush 4 ships no `.d.ts` and is ESM-only; without types, strict TS fails with TS7016. |
| `@playwright/test` | `~1.63.0` | Headless canvas E2E. |

**No `pnpm.onlyBuiltDependencies` block.** Verified across the full install under pnpm 11.25.0:
zero install scripts run, and pnpm creates no policy file. Vite 8 no longer depends on
esbuild (rolldown + lightningcss), so the classic "approve-builds blocks esbuild" gotcha is
obsolete. Note `onlyBuiltDependencies` is *silently ignored* in pnpm 11 — copy-pasted
`allow-scripts`/`onlyBuiltDependencies` advice from older blog posts has no effect.

**Tauri is deferred** out of Task 0.1 into its own task. Nothing in Tasks 0.2/0.3 touches
Rust, and keeping cargo/MSVC/WebView2 out of the first gate removes the slowest and least
deterministic variable. (Toolchain is present: cargo 1.97.0.)

---

## ADR-005 — The egress invariant is restated as three falsifiable tests

**Status:** Accepted · 2026-10-08 · Blocks Task 0.2

**Context.** `CLAUDE.md` claims the egress rule is "Automatic Test Failure" on violation.
As written it is unfalsifiable in Phase 0: nothing in Phase 0 touches the network, so a
test asserting "no request was made" passes vacuously and forever.

**Decision.** Replace it with three tests that can each actually fail:

1. **Predicate unit test** — a pure `canLeaveDevice(layer, kind)` over the full
   layer × type matrix. Fails if a matrix entry is wrong.
2. **Global egress tripwire** — installed over `fetch`/`XMLHttpRequest`/`WebSocket`/
   `EventSource`/`navigator.sendBeacon` **and armed for the entire test suite**, asserting
   zero invocations. Fails if any code path reaches the network.
3. **Content negative test** — a known sentinel string placed in a draft; assert it never
   appears in any captured payload. Paired with a **positive control**: the same search
   *must* find the sentinel in the local (non-egress) payload, so the negative assertion
   cannot pass vacuously.

The tripwire is also why ADR-001's telemetry beacon is disqualifying rather than merely
inconvenient.

---

## ADR-006 — Two spatial indices, split at the enclave boundary

**Status:** Accepted · 2026-10-08 · Blocks Task 0.3

**Context.** `rbush` stores items **by reference** and never clones. Writing new `x`/`y`
onto an object already in the tree silently desynchronises the stored bbox from the object,
with no error. One global tree spanning the enclave boundary would make that mistake a
privacy bug, not just a rendering bug.

**Decision.** Two `RBush` instances: `worldTree` (the three shareable layers) and
`privateTree` (`private_draft`). The layer predicate lives in exactly one function, so the
classification exists in one place. Inserted items are frozen, so the mutation mistake
throws in dev rather than corrupting the index. Removal always passes an `equalsFn` —
without it, `remove()` degrades to reference equality and returns unchanged **with no
exception**, which would look exactly like a correct delete.
