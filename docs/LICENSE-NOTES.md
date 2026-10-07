# Third-Party Licences

Penumbra is MIT-licensed. Every runtime dependency is MIT or equivalently
permissive, with one historical exception that is recorded in
[ADR-001](../docs/ADR/ADR-001-through-006.md) and no longer applies.

## Runtime dependencies

| Package | Licence | Role |
|---|---|---|
| `react`, `react-dom` | MIT | Rendering |
| `yjs` | MIT | CRDT substrate (Layer 5) |
| `y-indexeddb` | MIT | Local CRDT persistence — local only, no network transport |
| `rbush` | MIT | 2D R-Tree spatial index |
| `zod` | MIT | Schema validation at the store boundary |

## Dev dependencies

`@eslint/js`, `eslint`, `typescript-eslint`, `eslint-plugin-react-hooks`, `globals`,
`typescript`, `vite`, `vitest`, `@vitejs/plugin-react`, `tailwindcss`,
`@tailwindcss/vite`, `@playwright/test`, `@types/*`, `jsdom`, `cross-env`, `prettier`
— all MIT or Apache-2.0.

## tldraw — considered and rejected

Phase 0 removed `@tldraw/tldraw` as a hard dependency. The reason is not a
preference; it is a licence and security finding, documented in full in ADR-001:

1. **It is not open source.** `npm view @tldraw/tldraw license` returns
   `SEE LICENSE IN LICENSE.md`, not an SPDX identifier. Its licence permits use in
   a "Development Environment" only and requires that the software "Not to use the
   Software in Production Environments". tldraw's own documentation states that
   code under its SDK licence "would not be Open Source by any definition".

2. **It fires an unconditional telemetry beacon.** `LicenseManager.maybeTrack()`
   issues `fetch()` to `cdn.tldraw.com/watermarks/watermark-track.svg` with
   `window.location.href` in the query string, for anyone without a paid key. There
   is no opt-out flag. This runs inside the renderer's own component tree, so it
   cannot be prevented by any store-layer design — and it directly contradicts
   Penumbra's ZERO EGRESS invariant for `private_draft`.

3. **Every downstream user would need a paid licence key.** The editor renders an
   `UnlicensedWatermark` without one, and past a 5-second licence timeout stops
   rendering altogether.

If you want the tldraw rendering path anyway, it is reachable as an optional
adapter behind the `CanvasEngine` interface — see `src/core/canvas/`. It is not a
`dependencies` entry, so the repository stays 100% OSI-approved open source.
