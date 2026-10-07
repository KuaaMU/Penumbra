/**
 * The one place in Penumbra where data may cross the device boundary — and even here,
 * only after a policy check.
 *
 * Every other module is forbidden from calling `fetch` by ESLint (see eslint.config.js).
 * That rule is what makes this file the single choke point rather than one of many.
 */
import { canLeaveDevice, type LayerType } from '../model/nodes.ts'
import { EnclaveViolation } from './enclave.ts'

export interface EgressPolicy {
  readonly kind: 'deny-all' | 'allow'
  /** Only meaningful when kind === 'allow'. Every entry is re-checked per record. */
  readonly layers: readonly LayerType[]
}

export const DENY_ALL: EgressPolicy = { kind: 'deny-all', layers: [] }

/**
 * Defence in depth for ADR-002.
 *
 * The primary guarantee is structural: the enclave document is a separate object that
 * no transport is ever handed. This check catches the mistake where someone later
 * "simplifies" by pointing the shared transport at the full document set.
 */
export function assertLayersMayLeave(policy: EgressPolicy, layers: readonly LayerType[]): void {
  if (policy.kind === 'deny-all') {
    throw new EnclaveViolation(['deny-all policy cannot be overridden by a layer list'], layers)
  }
  const blocked = layers.filter((layer) => !canLeaveDevice(layer) || !policy.layers.includes(layer))
  if (blocked.length > 0) throw new EnclaveViolation(['layers not permitted to leave the device'], blocked)
}

/** The shape a transport must accept. It receives nodes, not a Y.Doc, so it cannot
 *  reach draft content by accident — only what a caller deliberately hands it. */
export interface OutboundPayload {
  readonly layers: readonly LayerType[]
  readonly nodes: readonly Readonly<Record<string, unknown>>[]
}
