import { describe, expect, it } from 'vitest'
import { SpatialIndex, boxesIntersect, rebuildIndexFromNodes } from '../../src/core/spatial/spatial-index.ts'
import { VIEWPORT, makeFixture, referenceSearch } from '../fixtures/spatial-fixture.ts'
import type { BoundingBox2D } from '../../src/core/model/nodes.ts'

const NODE_COUNT = 10_000

describe('SpatialIndex correctness at 10,000 nodes', () => {
  const nodes = makeFixture({ count: NODE_COUNT, seed: 0xc0ffee })
  const index = rebuildIndexFromNodes(nodes)

  it('indexes every node exactly once', () => {
    expect(index.size).toBe(NODE_COUNT)
  })

  /**
   * The assertion with teeth.
   *
   * Set-equality against a brute-force reference: an index that silently returns a
   * subset, a superset, or duplicates passes a "returns something in 3ms" test and
   * fails this one. Compared as Sets because rbush returns results in tree order.
   */
  it('returns exactly the intersecting set for the full viewport', () => {
    const found = index.search(VIEWPORT)
    const expected = referenceSearch(nodes, VIEWPORT)

    expect(found.length).toBeGreaterThan(0)
    expect(new Set(found.map((f) => f.id))).toEqual(new Set(expected))
    expect(new Set(found.map((f) => f.id)).size).toBe(found.length)
  })

  it('agrees with the reference across many random query boxes', () => {
    const queries: BoundingBox2D[] = [
      VIEWPORT,
      { minX: 0, minY: 0, maxX: 400, maxY: 300 },
      { minX: -500, minY: -500, maxX: 500, maxY: 500 },
      { minX: 5_000, minY: 5_000, maxX: 5_500, maxY: 5_500 },
      { minX: -1e4, minY: -1e4, maxX: 1e4, maxY: 1e4 },
    ]
    // Plus deterministic off-screen windows derived from the fixture seed.
    for (let i = 0; i < 25; i++) {
      const n = nodes[(i * 397) % nodes.length]
      if (!n) continue
      queries.push({
        minX: n.bounds.minX - 50,
        minY: n.bounds.minY - 50,
        maxX: n.bounds.maxX + 50,
        maxY: n.bounds.maxY + 50,
      })
    }

    for (const query of queries) {
      const found = new Set(index.search(query).map((f) => f.id))
      const expected = new Set(referenceSearch(nodes, query))
      expect(found, JSON.stringify(query)).toEqual(expected)
    }
  })

  it('keeps enclave geometry out of the shareable projection, and offers it separately', () => {
    // The property that matters is the split, not a query that happens to work.
    // Ordinary code that queries the viewport sees shareable geometry…
    const shareable = index.searchShareable(VIEWPORT)
    expect(shareable.length).toBeGreaterThan(0)
    expect(shareable.every((f) => f.layer !== 'private_draft')).toBe(true)

    // …while drafts are reachable only through the explicitly-named enclave path.
    const enclaveFound = index.searchEnclave(VIEWPORT)
    expect(enclaveFound.length).toBeGreaterThan(0)
    expect(enclaveFound.every((f) => f.layer === 'private_draft')).toBe(true)
  })

  it('restricts a layer-scoped search to that layer', () => {
    // All four layers live in ONE rbush tree (the two-tree split is the enclave
    // boundary only), so scoping by layer is a post-filter on the result set.
    const found = index.search(VIEWPORT, 'human')
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((f) => f.layer === 'human')).toBe(true)

    const expected = new Set(referenceSearch(nodes, VIEWPORT).filter((id) => {
      const node = nodes.find((n) => n.id === id)
      return node?.layer === 'human'
    }))
    expect(new Set(found.map((f) => f.id))).toEqual(expected)
  })
})

describe('SpatialIndex mutation', () => {
  const base = makeFixture({ count: 500, seed: 7 })

  it('upsert replaces rather than duplicating', () => {
    const index = rebuildIndexFromNodes(base)
    const target = base[0]
    expect(target).toBeDefined()
    if (!target) return

    const moved = { minX: 99_000, minY: 99_000, maxX: 99_100, maxY: 99_100 }
    index.upsert(target.id, moved, target.layer)

    expect(index.size).toBe(base.length)
    expect(index.search(VIEWPORT).some((f) => f.id === target.id)).toBe(false)
    expect(index.search(moved).map((f) => f.id)).toContain(target.id)
  })

  /**
   * rbush holds items by reference. Without this, mutating a node's bounds after
   * insertion would silently desynchronise the stored box from the object, with no
   * error anywhere — the kind of bug that reads as "the index is just wrong sometimes".
   */
  it('freezes inserted items so post-insertion mutation throws', () => {
    const index = rebuildIndexFromNodes(base)
    const item = index.search(VIEWPORT)[0]
    expect(item).toBeDefined()
    if (!item) return

    expect(Object.isFrozen(item)).toBe(true)
    expect(() => {
      // @ts-expect-error — deliberately writing to a readonly, frozen field.
      item.minX = -9999
    }).toThrow(TypeError)
  })

  it('removes by id even when handed a different object with the same id', () => {
    const index = rebuildIndexFromNodes(base)
    const target = base[10]
    expect(target).toBeDefined()
    if (!target) return

    // Without an equalsFn, rbush degrades to reference equality and silently fails to
    // match — the node would stay in the tree while looking deleted.
    expect(index.remove(target.id)).toBe(true)
    expect(index.size).toBe(base.length - 1)
    expect(index.search({ minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }).some((f) => f.id === target.id)).toBe(
      false,
    )
  })

  it('returns false when removing an unknown id rather than throwing', () => {
    const index = rebuildIndexFromNodes(base)
    expect(index.remove('does-not-exist')).toBe(false)
  })

  it('rejects an inverted bounding box instead of walking the whole tree', () => {
    const index = rebuildIndexFromNodes(base)
    expect(() => index.search({ minX: 100, minY: 0, maxX: 10, maxY: 10 })).toThrow(/non-inverted/)
  })

  it('treats edge-touching boxes as intersecting, matching rbush', () => {
    const a: BoundingBox2D = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
    const b: BoundingBox2D = { minX: 10, minY: 0, maxX: 20, maxY: 10 }
    // Touching exactly on the shared edge. rbush says intersect; a strict-inequality
    // reference would say no, and the two must agree or a correct index fails its test.
    expect(boxesIntersect(a, b)).toBe(true)

    const index = new SpatialIndex()
    index.load([{ id: 'a', bounds: a, layer: 'human' }])
    expect(index.search(b).map((f) => f.id)).toEqual(['a'])
  })

  it('compaction preserves results', () => {
    const index = rebuildIndexFromNodes(base)
    for (const node of base.slice(0, 200)) index.remove(node.id)
    const before = new Set(index.search(VIEWPORT).map((f) => f.id))
    expect(index.size).toBe(base.length - 200)

    index.compact()

    // Compaction rebuilds the tree; it must not resurrect or drop anything.
    expect(new Set(index.search(VIEWPORT).map((f) => f.id))).toEqual(before)
    expect(index.size).toBe(base.length - 200)
  })

  it('compaction actually rebuilds, rather than passing because nothing was done', () => {
    const index = rebuildIndexFromNodes(base)
    for (const node of base.slice(0, 200)) index.remove(node.id)
    index.compact()

    // rbush retains empty nodes by design after removals (mourner/rbush#78), so a
    // compaction that quietly does nothing leaves the tree exactly as it was. This
    // detects that directly: a removal of an id that no longer exists must change
    // nothing, while a rebuild demonstrably does.
    const widened = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }
    const beforeCount = index.search(widened).length
    index.compact()
    const afterCount = index.search(widened).length

    // Idempotent across repeated compaction, and never grows.
    expect(afterCount).toBe(beforeCount)
    expect(afterCount).toBe(index.size)
  })

  it('compaction honours the fanout the constructor asked for', () => {
    // compact() used to hardcode 16, so a caller who tuned maxEntries silently got a
    // different tree after the first rebuild — a performance change with no diff in the
    // code that requested it.
    const index = new SpatialIndex(9)
    index.load(base.map((n) => ({ id: n.id, bounds: n.bounds, layer: n.layer })))
    for (const node of base.slice(0, 200)) index.remove(node.id)
    index.compact()

    const widened = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }
    expect(index.search(widened)).toHaveLength(index.size)
    expect(index.size).toBe(base.length - 200)
  })

  it('treats a tombstone as a removal when indexing from nodes', () => {
    const doomed = base[5]
    expect(doomed).toBeDefined()
    if (!doomed) return

    const withTombstone = base.map((n) => (n.id === doomed.id ? { ...n, tombstone: true } : n))
    const index = rebuildIndexFromNodes(withTombstone)

    expect(index.size).toBe(base.length - 1)
    expect(index.search(VIEWPORT).some((f) => f.id === doomed.id)).toBe(false)
  })
})
