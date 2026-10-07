/**
 * Deterministic fixture generation.
 *
 * Math.random() would make a failure unreproducible, and a perf test whose workload
 * changes per run measures noise, not code. mulberry32 is a 32-bit PRNG: tiny, fast,
 * and identical across runs given the same seed.
 */
import type { BoundingBox2D, LayerType } from '../../src/core/model/nodes.ts'

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface FixtureNode {
  id: string
  bounds: BoundingBox2D
  layer: LayerType
}

export const VIEWPORT: BoundingBox2D = { minX: 0, minY: 0, maxX: 1920, maxY: 1080 }

export interface FixtureOptions {
  count: number
  seed: number
  /** Coordinate space the boxes are drawn from. */
  spread?: number
  /** Fraction of nodes forced inside the viewport, so the query is actually exercised. */
  denseFraction?: number
  layers?: readonly LayerType[]
}

/**
 * Build a deterministic node set.
 *
 * `denseFraction` exists because uniform random boxes make a viewport query nearly
 * useless as a test: across a 10,000-node uniform draw only ~57 land in a 1920x1080
 * window, so the tree is barely exercised and the result would be trivially correct.
 */
export function makeFixture({
  count,
  seed,
  spread = 20_000,
  denseFraction = 0.25,
  layers = ['human', 'agent_annotation', 'agent_debate', 'private_draft'],
}: FixtureOptions): FixtureNode[] {
  const rand = mulberry32(seed)
  const denseCount = Math.floor(count * denseFraction)
  const nodes: FixtureNode[] = []

  for (let i = 0; i < count; i++) {
    const isDense = i < denseCount
    const w = 20 + rand() * 180
    const h = 20 + rand() * 180
    const minX = isDense
      ? VIEWPORT.minX - w / 2 + rand() * (VIEWPORT.maxX - VIEWPORT.minX + w)
      : (rand() * spread - spread / 2)
    const minY = isDense
      ? VIEWPORT.minY - h / 2 + rand() * (VIEWPORT.maxY - VIEWPORT.minY + h)
      : (rand() * spread - spread / 2)

    const layer = layers[i % layers.length] ?? 'human'
    nodes.push({
      id: `node-${i}`,
      bounds: {
        minX: Number(minX.toFixed(3)),
        minY: Number(minY.toFixed(3)),
        maxX: Number((minX + w).toFixed(3)),
        maxY: Number((minY + h).toFixed(3)),
      },
      // Give the enclave layer some real content so the split is exercised.
      layer,
    })
  }
  return nodes
}

/**
 * rbush's own intersection predicate, replicated exactly.
 *
 * Inclusive on every edge: two boxes that merely touch intersect. A reference written
 * with strict `<`/`>` disagrees on exactly those inputs, so a *correct* implementation
 * would fail the correctness test. This is the single most common way a spatial-index
 * test suite lies to itself.
 */
export function referenceSearch(items: readonly FixtureNode[], box: BoundingBox2D): string[] {
  return items
    .filter(
      (item) =>
        box.minX <= item.bounds.maxX &&
        box.minY <= item.bounds.maxY &&
        box.maxX >= item.bounds.minX &&
        box.maxY >= item.bounds.minY,
    )
    .map((item) => item.id)
}

/** The reference implementation, for the ratio assertion that a slow machine cannot fake. */
export function bruteForceSearch(items: readonly FixtureNode[], box: BoundingBox2D): string[] {
  return referenceSearch(items, box)
}
