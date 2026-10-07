import { afterEach, beforeEach } from 'vitest'
import { egressRecords, installEgressTripwire, onEgress, resetEgressTripwire } from '../src/core/net/egress-tripwire.ts'

/**
 * Armed for the ENTIRE suite, not just the enclave tests.
 *
 * A tripwire that only guards its own test file proves nothing about the rest of the
 * codebase. Installed here in setup, it means any code path in any test that reaches
 * for the network fails the test that reached for it — including third-party code we
 * do not control.
 */
beforeEach(() => {
  installEgressTripwire()
  resetEgressTripwire()
})

afterEach(() => {
  // A leaked attempt is a bug even when the test did not assert on it, so it is
  // reported rather than silently discarded.
  const leaked = egressRecords()
  if (leaked.length > 0) {
    const summary = leaked.map((r) => `${r.api} -> ${r.target}`).join('; ')
    throw new Error(`Penumbra ZERO EGRESS violation in test: ${summary}`)
  }
})

// Keep the listener surface exercised so it is not dead code: subscribing and
// unsubscribing must both be no-ops from the test's perspective.
export function watchEgress(): () => void {
  return onEgress(() => {})
}
