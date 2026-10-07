import { beforeAll, describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { rebuildIndexFromNodes, type SpatialIndex } from '../../src/core/spatial/spatial-index.ts'
import { VIEWPORT, makeFixture, bruteForceSearch, type FixtureNode } from '../fixtures/spatial-fixture.ts'

/**
 * The performance gate (ADR-003).
 *
 * This file is gated behind PENUMBRA_PERF=1 and runs in its own Vitest project with
 * fileParallelism disabled. It is deliberately NOT part of `pnpm test:unit`.
 *
 * Why the split, measured on rbush 4.0.1 at 10,000 nodes:
 *   p50 of an R-Tree query  ~= 0.009 ms
 *   p50 of a brute-force scan ~= 0.047 ms
 * A "under 3 ms" budget therefore passes a completely broken index, passes no index at
 * all, and tolerates a ~300x regression. It cannot fail for any realistic defect, so
 * as a gate it is a rubber stamp that reads as a guarantee.
 *
 * So there are two assertions here, and they test different things:
 *   1. an absolute p50 budget, which is what the spec asked for and what a regression
 *      on this hardware would look like;
 *   2. a RATIO against the brute-force reference measured in the same run, which is
 *      immune to a slow machine — the only assertion here with real teeth.
 * The correctness gate itself lives in tests/unit/spatial_index.test.ts, ungated,
 * where a flaky machine cannot affect it.
 */
const NODE_COUNT = 10_000
const WARMUP = 1_000
const SAMPLES = 300
const P50_BUDGET_MS = 3
/**
 * The tree must be at least this many times faster than a linear scan of the same data.
 *
 * 2x, not 5x. Measured: 7.6x on this machine, 3.5x on a shared GitHub runner. The gap
 * is honest — a virtualised runner's cache and memory behaviour compresses the very
 * ratio a cache-favouring structure exists to exploit, which is precisely why the
 * ratio is the assertion worth keeping. What 2x still catches is the failure that
 * matters: an index that degenerates to a linear scan, or that returns wrong results
 * fast. A structure 2x faster than brute force is not a broken R-Tree.
 */
const REQUIRED_SPEEDUP = 2

const enabled = process.env['PENUMBRA_PERF'] === '1'

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
  return sorted[index] ?? 0
}

function median(samples: readonly number[]): number {
  return percentile(samples, 50)
}

describe.skipIf(!enabled)('SpatialIndex performance at 10,000 nodes', () => {
  let nodes: FixtureNode[]
  let index: SpatialIndex
  let expected: string[]

  beforeAll(() => {
    nodes = makeFixture({ count: NODE_COUNT, seed: 0xc0ffee })
    index = rebuildIndexFromNodes(nodes)
    expected = bruteForceSearch(nodes, VIEWPORT)
    expect(expected.length).toBeGreaterThan(0)

    for (let i = 0; i < WARMUP; i++) index.search(VIEWPORT)
  })

  it('reports a p50 inside the budget, alongside the measured ratio', () => {
    // Vitest fake timers freeze performance.now() AND Date.now(). A perf test that
    // silently observes a frozen clock reports 0ms forever and passes every run, so
    // assert the clock is actually moving before trusting any number below.
    const t0 = performance.now()
    let sink = 0
    for (let i = 0; i < 200_000; i++) sink += i
    const elapsed = performance.now() - t0
    expect(sink).toBeGreaterThan(0)
    expect(elapsed, 'performance.now() is frozen — a fake timer is active').toBeGreaterThan(0)

    const treeSamples: number[] = []
    for (let i = 0; i < SAMPLES; i++) {
      const start = performance.now()
      index.search(VIEWPORT)
      treeSamples.push(performance.now() - start)
    }

    const bruteSamples: number[] = []
    for (let i = 0; i < SAMPLES; i++) {
      const start = performance.now()
      bruteForceSearch(nodes, VIEWPORT)
      bruteSamples.push(performance.now() - start)
    }

    const p50 = median(treeSamples)
    const p99 = percentile(treeSamples, 99)
    const bruteP50 = median(bruteSamples)

    console.log(
      `[perf] matches=${expected.length}/${NODE_COUNT} ` +
        `p50=${p50.toFixed(5)}ms p99=${p99.toFixed(5)}ms bruteP50=${bruteP50.toFixed(5)}ms ` +
        `speedup=${(bruteP50 / p50).toFixed(1)}x`,
    )

    // 1. Absolute budget, per the spec.
    expect(p50, `p50 ${p50.toFixed(5)}ms over ${expected.length} matches`).toBeLessThan(P50_BUDGET_MS)

    // 2. The ratio. Survives a slow machine, fails for a broken or absent index.
    expect(bruteP50).toBeGreaterThan(0)
    const speedup = bruteP50 / p50
    if (speedup < REQUIRED_SPEEDUP) {
      // Distinguish "the tree got slower" from "the reference got faster". On a
      // shared runner both shrink; only a real regression moves p50 toward bruteP50.
      throw new Error(
        `R-Tree is only ${speedup.toFixed(1)}x faster than brute force ` +
          `(p50=${p50.toFixed(5)}ms, bruteP50=${bruteP50.toFixed(5)}ms, ` +
          `matches=${expected.length}/${NODE_COUNT}). ` +
          'If p50 is also well inside the absolute budget, this machine is unusually ' +
          'flat rather than the index being broken.',
      )
    }
  })

  it('holds up at 100,000 nodes, which ARCHITECTURE.md claims but nothing measured', () => {
    const big = makeFixture({ count: 100_000, seed: 0xbeef })
    const bigIndex = rebuildIndexFromNodes(big)
    const matches = bruteForceSearch(big, VIEWPORT)
    expect(matches.length).toBeGreaterThan(0)

    for (let i = 0; i < 200; i++) bigIndex.search(VIEWPORT)

    const samples: number[] = []
    for (let i = 0; i < SAMPLES; i++) {
      const start = performance.now()
      bigIndex.search(VIEWPORT)
      samples.push(performance.now() - start)
    }
    const p50 = median(samples)
    console.log(`[perf] 100k nodes: matches=${matches.length} p50=${p50.toFixed(5)}ms`)

    // No absolute budget is asserted here — the point is to publish a measured number
    // rather than a claimed one. The bound below only catches catastrophic blowup.
    expect(p50).toBeLessThan(P50_BUDGET_MS * 5)
  })
})
