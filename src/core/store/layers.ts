/**
 * Layer and authority policy.
 *
 * The enclave boundary is decided here, once, and everything else imports it
 * (ADR-002). `private_draft` is a physically separate `Y.Doc` — not a layer inside a
 * shared one — because Yjs has no way to serialise "everything except this namespace":
 * `encodeStateAsUpdate` filters only by per-client clock, one transaction emits one
 * merged byte array, and `y-indexeddb` persists the whole document. A runtime guard at
 * a serialization boundary cannot see a layer inside opaque bytes.
 *
 * Keeping the classification in one place also means the spatial index can split its
 * two trees at exactly this boundary (ADR-006).
 */
import { canLeaveDevice, type LayerType } from '../model/nodes.ts'

/** Layers that share one document and may be synchronised. */
export const SHAREABLE_LAYERS = ['human', 'agent_annotation', 'agent_debate'] as const satisfies readonly LayerType[]

/** The enclave. A separate document, a separate database, never handed to a provider. */
export const ENCLAVE_LAYER = 'private_draft' as const satisfies LayerType

export type ShareableLayer = (typeof SHAREABLE_LAYERS)[number]

export function isShareableLayer(layer: LayerType): layer is ShareableLayer {
  return canLeaveDevice(layer)
}

export function isEnclaveLayer(layer: LayerType): boolean {
  return !canLeaveDevice(layer)
}

/** Root-type name for a layer inside the shared document. */
export function layerRootName(layer: LayerType): string {
  return `layer:${layer}`
}

export const LAYER_ROOT_NAMES: Record<LayerType, string> = {
  human: layerRootName('human'),
  agent_annotation: layerRootName('agent_annotation'),
  agent_debate: layerRootName('agent_debate'),
  private_draft: layerRootName('private_draft'),
}
