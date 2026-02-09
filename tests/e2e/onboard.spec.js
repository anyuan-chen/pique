import { test, expect } from '@playwright/test';
import { mockOnboardingAPIs, scenarios, createFakeVideoFile } from './fixtures.js';

test.describe('Mobile Onboarding', () => {
  test.describe('Flow 1: New Restaurant', () => {
    test('completes full flow: search → select → create → upload → processing → redirect', async ({ page }) => {
      await mockOnboardingAPIs(page, scenarios.newRestaurant);

      // Track API calls made
      const apiCalls = [];
      page.on('request', request => {
        if (request.url().includes('/api/')) {
          apiCalls.push({
            method: request.method(),
            url: request.url()
          });
        }
      });

      await page.goto('/mobile/onboard.html');

      // Verify search screen is active
      await expect(page.locator('#screen-search')).toBeVisible();
      await expect(page.locator('#screen-search')).toHaveClass(/active/);

      // Search for restaurant
      await page.fill('#search-input', 'test restaurant');

      // Wait for search results to appear
      await expect(page.locator('.result-item').first()).toBeVisible();

      // Verify search API was called
      expect(apiCalls.some(c => c.url.includes('/api/onboard/search'))).toBe(true);

      // Select first result
      await page.click('.result-item:first-child');

      // Should transition to upload screen (after check + create)
      // Note: checking screen may transition too fast to reliably assert
      await expect(page.locator('#screen-upload')).toBeVisible({ timeout: 5000 });

      // Verify check and create APIs were called
      expect(apiCalls.some(c => c.url.includes('/api/onboard/check'))).toBe(true);
      expect(apiCalls.some(c => c.url.includes('/api/onboard/create'))).toBe(true);

      // Upload video
      const fileInput = page.locator('#video-input');
      await fileInput.setInputFiles(createFakeVideoFile());

      // Should show processing screen
      await expect(page.locator('#screen-processing')).toBeVisible();

      // Wait for processing to complete and confirm screen to appear
      await expect(page.locator('#screen-confirm')).toBeVisible({ timeout: 10000 });

      // Verify upload and status APIs were called
      expect(apiCalls.some(c => c.url.includes('/api/upload/video'))).toBe(true);
      expect(apiCalls.some(c => c.url.includes('/api/upload/status/'))).toBe(true);

      // Verify menu items are displayed
      await expect(page.locator('.menu-item')).toHaveCount(3);

      // Click confirm button
      await page.click('#confirm-btn');

      // Wait for redirect after confirmation
      await page.waitForURL('**/mobile/?restaurantId=new-123', { timeout: 10000 });
    });
  });

  test.describe('Flow 2: Existing Restaurant Without Data', () => {
    test('skips create step: search → select → check → upload → processing → redirect', async ({ page }) => {
      await mockOnboardingAPIs(page, scenarios.existingWithoutData);

      const apiCalls = [];
      page.on('request', request => {
        if (request.url().includes('/api/')) {
          apiCalls.push({
            method: request.method(),
            url: request.url()
          });
        }
      });

      await page.goto('/mobile/onboard.html');

      // Search and select
      await page.fill('#search-input', 'test restaurant');
      await expect(page.locator('.result-item').first()).toBeVisible();
      await page.click('.result-item:first-child');

      // Should go to upload screen (skipping create since restaurant exists)
      await expect(page.locator('#screen-upload')).toBeVisible({ timeout: 5000 });

      // Verify create was NOT called (restaurant already exists)
      expect(apiCalls.some(c => c.url.includes('/api/onboard/create'))).toBe(false);

      // Upload and complete
      const fileInput = page.locator('#video-input');
      await fileInput.setInputFiles(createFakeVideoFile());

      await expect(page.locator('#screen-processing')).toBeVisible();

      // Wait for confirm screen
      await expect(page.locator('#screen-confirm')).toBeVisible({ timeout: 10000 });

      // Confirm and redirect
      await page.click('#confirm-btn');
      await page.waitForURL('**/mobile/?restaurantId=existing-789', { timeout: 10000 });
    });
  });

  test.describe('Flow 3: Existing Restaurant With Data', () => {
    test('redirects immediately: search → select → check → redirect (no upload)', async ({ page }) => {
      await mockOnboardingAPIs(page, scenarios.existingWithData);

      const apiCalls = [];
      page.on('request', request => {
        if (request.url().includes('/api/')) {
          apiCalls.push({
            method: request.method(),
            url: request.url()
          });
        }
      });

      await page.goto('/mobile/onboard.html');

      // Search and select
      await page.fill('#search-input', 'test restaurant');
      await expect(page.locator('.result-item').first()).toBeVisible();
      await page.click('.result-item:first-child');

      // Should redirect directly without showing upload screen
      await page.waitForURL('**/mobile/?restaurantId=existing-789', { timeout: 5000 });

      // Verify no upload-related APIs were called
      expect(apiCalls.some(c => c.url.includes('/api/onboard/create'))).toBe(false);
      expect(apiCalls.some(c => c.url.includes('/api/upload/video'))).toBe(false);
    });
  });

  test.describe('UI Verification', () => {
    test('displays search results correctly', async ({ page }) => {
      await mockOnboardingAPIs(page, scenarios.newRestaurant);

      await page.goto('/mobile/onboard.html');
      await page.fill('#search-input', 'test');

      // Wait for results
      await expect(page.locator('.result-item')).toHaveCount(2);

      // Verify result content
      const firstResult = page.locator('.result-item').first();
      await expect(firstResult.locator('.result-name')).toHaveText('Test Restaurant');
      await expect(firstResult.locator('.result-address')).toHaveText('123 Main St, San Francisco, CA');
    });

    test('shows correct restaurant name in checking screen', async ({ page }) => {
      await mockOnboardingAPIs(page, scenarios.newRestaurant);

      await page.goto('/mobile/onboard.html');
      await page.fill('#search-input', 'test');
      await expect(page.locator('.result-item').first()).toBeVisible();
      await page.click('.result-item:first-child');

      // Checking screen should show restaurant name
      await expect(page.locator('#checking-name')).toHaveText('Test Restaurant');
    });

    test('shows progress updates during processing', async ({ page }) => {
      await mockOnboardingAPIs(page, scenarios.existingWithoutData);

      await page.goto('/mobile/onboard.html');
      await page.fill('#search-input', 'test');
      await expect(page.locator('.result-item').first()).toBeVisible();
      await page.click('.result-item:first-child');

      await expect(page.locator('#screen-upload')).toBeVisible({ timeout: 5000 });

      const fileInput = page.locator('#video-input');
      await fileInput.setInputFiles(createFakeVideoFile());

      // Verify progress bar appears and updates
      await expect(page.locator('#screen-processing')).toBeVisible();
      await expect(page.locator('#progress-fill')).toBeVisible();
      await expect(page.locator('#progress-text')).toBeVisible();

      // Wait for confirm screen
      await expect(page.locator('#screen-confirm')).toBeVisible({ timeout: 10000 });

      // Confirm and redirect
      await page.click('#confirm-btn');
      await page.waitForURL('**/mobile/?restaurantId=existing-789', { timeout: 10000 });
    });

    test('search input triggers debounced API call', async ({ page }) => {
      await mockOnboardingAPIs(page, scenarios.newRestaurant);

      let searchCallCount = 0;
      await page.route('**/api/onboard/search*', route => {
        searchCallCount++;
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ predictions: [] })
        });
      });

      await page.goto('/mobile/onboard.html');

      // Type quickly - should only trigger one debounced call
      await page.locator('#search-input').pressSequentially('test', { delay: 50 });

      // Wait for debounce (300ms) + network
      await page.waitForTimeout(500);

      // Should only have made one search call due to debounce
      expect(searchCallCount).toBe(1);
    });
  });

  test.describe('Error Handling', () => {
    test('handles search API error gracefully', async ({ page }) => {
      await page.route('**/api/onboard/search*', route => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Search service unavailable' })
        });
      });

      await page.goto('/mobile/onboard.html');
      await page.fill('#search-input', 'test');

      await expect(page.locator('.no-results')).toHaveText('Search service unavailable');
    });

    test('handles empty search results', async ({ page }) => {
      await page.route('**/api/onboard/search*', route => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ predictions: [] })
        });
      });

      await page.goto('/mobile/onboard.html');
      await page.fill('#search-input', 'nonexistent');

      await expect(page.locator('.no-results')).toHaveText('No restaurants found');
    });
  });

  test.describe('Menu Confirmation Flow', () => {
    test('displays menu items with review status', async ({ page }) => {
      await mockOnboardingAPIs(page, scenarios.newRestaurant);

      await page.goto('/mobile/onboard.html');

      // Complete flow to get to confirm screen
      await page.fill('#search-input', 'test restaurant');
      await expect(page.locator('.result-item').first()).toBeVisible();
      await page.click('.result-item:first-child');

      await expect(page.locator('#screen-upload')).toBeVisible({ timeout: 5000 });
      await page.locator('#video-input').setInputFiles(createFakeVideoFile());

      // Wait for confirm screen
      await expect(page.locator('#screen-confirm')).toBeVisible({ timeout: 10000 });

      // Verify menu items are displayed
      await expect(page.locator('.menu-item')).toHaveCount(3);

      // Verify needs-review item has correct styling
      const reviewItem = page.locator('.menu-item.needs-review');
      await expect(reviewItem).toHaveCount(1);
      await expect(reviewItem.locator('.status-badge.review')).toBeVisible();
    });

    test('allows editing menu item name', async ({ page }) => {
      await mockOnboardingAPIs(page, scenarios.newRestaurant);

      await page.goto('/mobile/onboard.html');

      // Navigate to confirm screen
      await page.fill('#search-input', 'test');
      await expect(page.locator('.result-item').first()).toBeVisible();
      await page.click('.result-item:first-child');
      await expect(page.locator('#screen-upload')).toBeVisible({ timeout: 5000 });
      await page.locator('#video-input').setInputFiles(createFakeVideoFile());
      await expect(page.locator('#screen-confirm')).toBeVisible({ timeout: 10000 });

      // Edit first item's name
      const itemName = page.locator('.menu-item').first().locator('.item-name');
      await itemName.click();
      await itemName.fill('Updated Pasta');
      await itemName.blur();

      // Verify the edit was made
      await expect(itemName).toHaveText('Updated Pasta');
    });

    test('allows removing a menu item', async ({ page }) => {
      await mockOnboardingAPIs(page, scenarios.newRestaurant);

      await page.goto('/mobile/onboard.html');

      // Navigate to confirm screen
      await page.fill('#search-input', 'test');
      await expect(page.locator('.result-item').first()).toBeVisible();
      await page.click('.result-item:first-child');
      await expect(page.locator('#screen-upload')).toBeVisible({ timeout: 5000 });
      await page.locator('#video-input').setInputFiles(createFakeVideoFile());
      await expect(page.locator('#screen-confirm')).toBeVisible({ timeout: 10000 });

      // Remove first item
      await page.locator('.menu-item').first().locator('.remove-btn').click();

      // Verify item is marked as removed
      await expect(page.locator('.menu-item.removed')).toHaveCount(1);
    });

    test('allows adding a new menu item', async ({ page }) => {
      await mockOnboardingAPIs(page, scenarios.newRestaurant);

      await page.goto('/mobile/onboard.html');

      // Navigate to confirm screen
      await page.fill('#search-input', 'test');
      await expect(page.locator('.result-item').first()).toBeVisible();
      await page.click('.result-item:first-child');
      await expect(page.locator('#screen-upload')).toBeVisible({ timeout: 5000 });
      await page.locator('#video-input').setInputFiles(createFakeVideoFile());
      await expect(page.locator('#screen-confirm')).toBeVisible({ timeout: 10000 });

      // Initial count
      await expect(page.locator('.menu-item')).toHaveCount(3);

      // Click add item button
      await page.click('#add-item-btn');

      // Should now have 4 items
      await expect(page.locator('.menu-item')).toHaveCount(4);

      // New item should be first and have default name
      await expect(page.locator('.menu-item').first().locator('.item-name')).toHaveText('New Item');
    });

    test('submits confirmed menu items via API', async ({ page }) => {
      await mockOnboardingAPIs(page, scenarios.newRestaurant);

      let putBody = null;
      await page.route('**/api/onboard/menu/*', route => {
        if (route.request().method() === 'PUT') {
          putBody = route.request().postDataJSON();
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true })
          });
        } else {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ menuItems: scenarios.newRestaurant.menuItems })
          });
        }
      });

      await page.goto('/mobile/onboard.html');

      // Navigate to confirm screen
      await page.fill('#search-input', 'test');
      await expect(page.locator('.result-item').first()).toBeVisible();
      await page.click('.result-item:first-child');
      await expect(page.locator('#screen-upload')).toBeVisible({ timeout: 5000 });
      await page.locator('#video-input').setInputFiles(createFakeVideoFile());
      await expect(page.locator('#screen-confirm')).toBeVisible({ timeout: 10000 });

      // Click confirm button
      await page.click('#confirm-btn');

      // Wait for redirect
      await page.waitForURL('**/mobile/?restaurantId=new-123', { timeout: 10000 });

      // Verify the PUT request was made
      expect(putBody).not.toBeNull();
      expect(putBody.items).toHaveLength(3);
    });
  });
});
