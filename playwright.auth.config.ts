import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const database = process.env.AUTH_E2E_DATABASE_PATH;
if (!database || !path.isAbsolute(database)) throw new Error('AUTH_E2E_DATABASE_PATH must be an absolute test database path');

export default defineConfig({
  testDir: './tests',
  testMatch: 'auth.live.spec.ts',
  workers: 1,
  use: { baseURL: 'http://localhost:3218', timezoneId: 'Asia/Singapore' },
  webServer: {
    command: `"${process.execPath}" "${path.join('node_modules', 'next', 'dist', 'bin', 'next')}" dev --hostname localhost --port 3218`,
    url: 'http://localhost:3218/login',
    reuseExistingServer: false,
    env: {
      DATABASE_PATH: database,
      JWT_SECRET: randomBytes(32).toString('hex'),
      RP_ID: 'localhost',
      RP_ORIGIN: 'http://localhost:3218',
      NEXT_TELEMETRY_DISABLED: '1',
    },
    timeout: 120_000,
  },
});
