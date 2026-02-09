import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
    viewport: { width: 390, height: 844 }, // iPhone 14 Pro
    trace: 'on-first-retry',
    video: 'on', // Record videos of all tests
  },
  webServer: {
    command: 'npm start',
    port: 3000,
    reuseExistingServer: true,
  },
});
