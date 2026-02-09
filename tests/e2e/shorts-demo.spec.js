import { test } from '@playwright/test';

test.use({
  viewport: { width: 1440, height: 900 },
  video: { mode: 'on', size: { width: 1440, height: 900 } },
});

test('shorts demo animation recording', async ({ page }) => {
  test.setTimeout(40000);

  await page.goto('/shorts-pipeline.html');

  // Wait for the full animation to play out
  await page.waitForTimeout(20000);

  // Take a final screenshot too for quick reference
  await page.screenshot({ path: 'tests/e2e/screenshots/shorts-final.png' });
});
