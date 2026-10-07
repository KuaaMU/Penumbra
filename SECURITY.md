# Security Policy

## Reporting

Please report security issues privately via GitHub's
[security advisory](https://github.com/KuaaMU/Penumbra/security/advisories/new) rather
than opening a public issue.

## The invariant most likely to be attacked

Penumbra's core promise is that content on the `private_draft` layer never leaves the
device. That guarantee is **structural**: those nodes live in a separate `Y.Doc` instance
that is never passed to a transport. We rely on this because Yjs offers no way to
serialise "everything except this namespace" — a single transaction emits one merged byte
array with no per-layer metadata, so a runtime filter at a serialization boundary cannot do
the job.

Supporting layers, in decreasing order of importance:

1. `src/core/store/canvas-store.ts` — the enclave document is never returned by any
   accessor that a transport can reach. `enclaveForLocalUseOnly()` requires an explicit
   acknowledgement argument so every call site is greppable.
2. `src/core/store/egress-policy.ts` — a defence-in-depth check that re-verifies the layer
   of every outbound record.
3. `src/core/net/egress-tripwire.ts` — a tripwire over `fetch`, `XMLHttpRequest`,
   `WebSocket`, `EventSource` and `navigator.sendBeacon`, armed for the whole test suite.
4. `eslint.config.js` — `no-restricted-syntax` bans `fetch` everywhere in `src/` except
   `src/core/net/`, so a new call site fails `pnpm lint` rather than review.

## Reporting a suspected leak

A report is most useful with:

- the layer involved and how you reached the network path,
- whether the leak reproduces in the test environment (a test failure is ideal),
- the commit or version.

Do not include real private draft content in the report.

## Threat model boundaries

Penumbra defends the content of private drafts. It does not currently defend against:

- a compromised browser extension or host process with access to the page's origin — any
  such code can read the enclave document directly. Isolation is between Penumbra's own
  layers, not against code already executing in the page.
- physical access to an unlocked device.
- content the user has deliberately exported or shared.
