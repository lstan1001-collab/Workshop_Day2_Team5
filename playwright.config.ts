import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/auth-ui.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:3105',
    timezoneId: 'Asia/Singapore',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --hostname localhost --port 3105',
    url: 'http://localhost:3105/login',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
