import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { APP_URL } from './src/stack';

// In a cloud container, use the preinstalled Chromium rather than the
// revision this @playwright/test pins (which must never be downloaded).
const preinstalled = '/opt/pw-browsers/chromium';
const executablePath = existsSync(preinstalled) ? preinstalled : undefined;

// One worker per emulator stack scripts/e2e.sh started (2026-11-15):
// E2E_WORKERS there, 1 for a serial run. Each worker drives its own
// stack (src/stack.ts), so journeys never share an emulator.
const workers = Number(process.env['E2E_WORKERS'] ?? 1);

export default defineConfig({
  testDir: './tests',
  fullyParallel: workers > 1,
  workers,
  retries: 0,
  reporter: [['list']],
  use: {
    // localhost, so the app talks to this worker's e2e emulator stack.
    baseURL: APP_URL,
    // No traces unless asked (2026-11-16, #312): recording one for
    // every journey cost a tenth of the run and 1.5 GB on a container
    // already short of both, and journeys missed their waits. To read
    // a failure, run that journey again with E2E_TRACE=on.
    trace: process.env['E2E_TRACE'] === 'on' ? 'retain-on-failure' : 'off',
  },
  projects: [
    {
      name: 'phone',
      use: { ...devices['Pixel 7'], launchOptions: { executablePath } },
    },
  ],
});
