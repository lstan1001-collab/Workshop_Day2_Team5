import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const secret = process.env.FRONTEND_TEST_SECRET ?? randomBytes(32).toString('hex');
process.env.FRONTEND_TEST_SECRET = secret;

export default defineConfig({
  testDir: './tests',
  testMatch: ['frontend.spec.ts', 'productivity.live.spec.ts'],
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3217', timezoneId: 'Asia/Singapore' },
  webServer: {
    command: `"${process.execPath}" "${path.join('node_modules', 'next', 'dist', 'bin', 'next')}" dev --hostname 127.0.0.1 --port 3217`,
    url: 'http://127.0.0.1:3217/login',
    reuseExistingServer: false,
    env: { JWT_SECRET: secret, NEXT_TELEMETRY_DISABLED: '1' },
    timeout: 120_000,
  },
});
