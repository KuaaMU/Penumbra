/**
 * The global egress tripwire (ADR-005).
 *
 * CLAUDE.md makes "no network egress from anything touching `private_draft`" an
 * absolute invariant and claims violations are an automatic test failure. As prose
 * that is unfalsifiable: a test asserting "no request was made" passes vacuously and
 * forever. This module is the mechanism that makes the claim true.
 *
 * Every egress-capable global is replaced with a recorder. Any invocation during the
 * test suite fails the test that caused it — including invocations from inside a
 * third-party dependency, which is precisely the case that motivated dropping tldraw
 * (its LicenseManager beacons `window.location.href` to cdn.tldraw.com with no opt-out).
 *
 * This is not a sandbox. It is a tripwire: it does not make egress impossible, it makes
 * egress *loud*. Removing it is a one-line diff and a constitution violation.
 */

export interface EgressRecord {
  readonly api: EgressApi
  readonly target: string
  readonly stack: string
}

export type EgressApi = 'fetch' | 'XMLHttpRequest' | 'WebSocket' | 'EventSource' | 'sendBeacon'

type Listener = (record: EgressRecord) => void

const records: EgressRecord[] = []
const listeners = new Set<Listener>()
let installed = false

/**
 * The globals object. `globalThis` already accepts these property assignments under
 * its own types, so no cast is needed — this module replaces well-typed globals with
 * deliberately differently-shaped stand-ins, and the type checker is not the guard
 * here. The tripwire is.
 */
function globalRef(): Record<string, unknown> {
  return globalThis
}

function describe(target: unknown): string {
  if (typeof target === 'string') return target
  if (target instanceof URL) return target.toString()
  if (target !== null && typeof target === 'object') {
    const url = (target as { url?: unknown }).url
    return typeof url === 'string' ? url : Object.prototype.toString.call(target)
  }
  return String(target)
}

function record(api: EgressApi, target: unknown): void {
  const entry: EgressRecord = {
    api,
    target: describe(target),
    // Capture the caller, not the tripwire itself — the point is to name the code
    // that reached for the network.
    stack: new Error(`egress: ${api} -> ${describe(target)}`).stack ?? '',
  }
  records.push(entry)
  for (const listener of listeners) listener(entry)
}

/** Replace every egress-capable global with a recorder. Idempotent. */
export function installEgressTripwire(): void {
  if (installed) return
  const g = globalRef()
  installed = true

  // Node under Vitest has no WebSocket/EventSource/XMLHttpRequest, so each guard is
  // a real portability check rather than dead code: the tripwire still arms them in
  // a browser-like environment where those globals do exist.
  if (typeof g.fetch === 'function') {
    g.fetch = (...args: unknown[]): Promise<never> => {
      record('fetch', args[0])
      return Promise.reject(new Error(`Penumbra egress blocked: fetch(${describe(args[0])})`))
    }
  }

  if (typeof g.WebSocket === 'function') {
    const Blocked = function (url: unknown) {
      record('WebSocket', url)
      throw new Error(`Penumbra egress blocked: WebSocket(${describe(url)})`)
    } as unknown as new (url: unknown) => never
    g.WebSocket = Blocked
  }

  if (typeof g.EventSource === 'function') {
    const Blocked = function (url: unknown) {
      record('EventSource', url)
      throw new Error(`Penumbra egress blocked: EventSource(${describe(url)})`)
    } as unknown as new (url: unknown) => never
    g.EventSource = Blocked
  }

  const nav = globalThis.navigator as Navigator | undefined
  if (nav && typeof nav.sendBeacon === 'function') {
    Object.defineProperty(nav, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: (url: unknown) => {
        record('sendBeacon', url)
        return false
      },
    })
  }

  if (typeof g.XMLHttpRequest === 'function') {
    // Only open() is reachable, and it always throws — the remaining members exist
    // so that construction itself cannot raise an unrelated error that would mask
    // the violation being reported.
    class BlockedXMLHttpRequest {
      open(method: string, url: unknown): void {
        record('XMLHttpRequest', url)
        throw new Error(`Penumbra egress blocked: XMLHttpRequest(${method} ${describe(url)})`)
      }
      send(): never {
        throw new Error('Penumbra egress blocked: XMLHttpRequest.send()')
      }
      setRequestHeader(): void {
        /* unreachable: open() throws first */
      }
      addEventListener(): void {
        /* no-op stub */
      }
    }
    g.XMLHttpRequest = BlockedXMLHttpRequest
  }
}

/** Every egress attempt recorded since the last {@link resetEgressTripwire}. */
export function egressRecords(): readonly EgressRecord[] {
  return records
}

/** Observe attempts as they happen (used to assert "never called", not "called once"). */
export function onEgress(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetEgressTripwire(): void {
  records.length = 0
}
