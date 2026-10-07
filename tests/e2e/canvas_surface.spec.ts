import { expect, test } from '@playwright/test'

/**
 * Phase 0 E2E smoke: the canvas surface mounts and the page makes no network
 * request of its own. Deliberately minimal — Phase 1 owns real canvas interaction,
 * and a test that asserts more than exists only invents failures.
 */
test.describe('Penumbra canvas surface', () => {
  test('mounts an empty infinite canvas with no conversational chrome', async ({ page }) => {
    await page.goto('/')

    const surface = page.getByTestId('canvas-surface')
    await expect(surface).toBeVisible()

    // The constitution's headline invariant, asserted at the DOM level: there is no
    // input box, no message list, and no dialog anywhere on the page. A linear chat
    // affordance is the failure this project must never regress into.
    await expect(page.locator('input, textarea')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('log')).toHaveCount(0)
  })

  test('makes no outbound request of its own', async ({ page }) => {
    const external: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      // Same-origin Vite/HMR traffic is the dev server, not the app.
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') external.push(request.url())
    })

    await page.goto('/')
    await expect(page.getByTestId('canvas-surface')).toBeVisible()

    expect(external, 'the page must not contact anything off-origin').toEqual([])
  })
})
