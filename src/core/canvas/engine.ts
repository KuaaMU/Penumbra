/**
 * CanvasEngine — the seam between Penumbra's spatial model and whatever renders it.
 *
 * This interface exists because the canvas SDK is a decision, not a constant.
 * `@tldraw/tldraw` was removed as a hard dependency (ADR-001): it is source-available
 * but not open source, needs a licence key to run in production, and its
 * `LicenseManager` beacons `window.location.href` to a CDN with no opt-out — which
 * no store-layer design can prevent, and which contradicts the ZERO EGRESS invariant.
 *
 * Phase 0 implements no adapter. This file is the contract that makes the renderer
 * swappable, so the next one is a Phase 1 task rather than a rewrite.
 */
import type { BoundingBox2D, LayerType, SpatialNode, VisibilityLevel } from '../model/nodes.ts'

/** A point in screen space, as the renderer sees it. */
export interface Viewport {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
  /** Zoom factor. Ambient by design: Penumbra must not feel like a document. */
  readonly zoom: number
}

/**
 * What a renderer can be asked to do.
 *
 * Deliberately narrow. Anything a renderer needs that is not here — hit testing,
 * selection, the disclosure state machine — belongs in Penumbra's core and is pushed
 * *into* the adapter, because that is where it can be tested without a browser.
 */
export interface CanvasEngine {
  /** Nodes currently in view, already filtered by layer and visibility. */
  readonly visibleNodes: readonly SpatialNode[]

  /** Replace the rendered node set. The engine must not mutate the input. */
  render(nodes: readonly SpatialNode[], viewport: Viewport): void

  /** Move the camera. Never blocks; an ambient surface must stay responsive. */
  panTo(bounds: BoundingBox2D): void

  /** Node under a screen-space point, if any. */
  hitTest(point: { x: number; y: number }): SpatialNode | undefined

  /**
   * Register a handler for a user gesture on a node.
   *
   * Progressive disclosure is driven from here and enforced in the core: an adapter
   * reports intent, `CanvasStore.setVisibility` decides whether it is legal, and the
   * engine re-renders. An adapter must never be able to reach `unfolded` on its own.
   */
  onIntent(nodeId: string, intent: UserIntent): void

  dispose(): void
}

/** A user gesture on a node. Nothing here carries content — only intent. */
export type UserIntent =
  | { readonly kind: 'hover' }
  | { readonly kind: 'tap' }
  | { readonly kind: 'focus' }
  | { readonly kind: 'dismiss' }

/**
 * The single source of truth for what may be drawn at a given tier.
 *
 * A renderer that reads `unfoldedSolution` without consulting this is the single most
 * dangerous mistake available in this codebase, so the payload is never handed to the
 * engine at all — the core projects it first.
 */
export function projectForVisibility(node: SpatialNode): Record<string, unknown> {
  if (node.type !== 'scaffolding') return { type: node.type }
  if (node.visibility === 'subconscious' || node.visibility === 'glow') {
    return { type: node.type, hint: null }
  }

  const { socraticHint, divergenceMatrix, unfoldedSolution } = node.payload
  const deep = node.visibility === 'divergence' || node.visibility === 'unfolded'

  // Conditional spread rather than post-hoc assignment, so a field that is not yet
  // authorised does not exist on the object at all — there is nothing for a renderer
  // to reach for even by accident.
  return {
    type: node.type,
    hint: socraticHint,
    ...(deep && divergenceMatrix ? { divergenceMatrix } : {}),
    ...(node.visibility === 'unfolded' && unfoldedSolution ? { unfoldedSolution } : {}),
  }
}

export type { BoundingBox2D, LayerType, SpatialNode, VisibilityLevel }
