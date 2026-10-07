import type { LayerType } from '../model/nodes.ts'

/**
 * Thrown whenever a request would carry private_draft content off the device.
 *
 * Deliberately distinct from a generic Error: `name` is checked in tests, and the
 * offending layers are attached so a failure report says which layer leaked rather
 * than just "something did".
 */
export class EnclaveViolation extends Error {
  readonly name = 'EnclaveViolation'
  readonly layers: readonly LayerType[]

  constructor(reasons: readonly string[], layers: readonly LayerType[]) {
    super(`ZERO EGRESS violation: ${reasons.join('; ')} [${layers.join(', ')}]`)
    this.layers = layers
  }
}
