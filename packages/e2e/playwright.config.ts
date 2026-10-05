import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// In a cloud container, use the preinstalled Chromium rather than the
// revision this @playwright/test pins (which must never be downloaded).
const preinstalled = '/opt/pw-browsers/chromium';
const executablePath = existsSync(preinstalled) ? preinstalled : undefined;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    // localhost, so the app talks to the e2e emulator suite.
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:4300',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'phone',
      use: { ...devices['Pixel 7'], launchOptions: { executablePath } },
    },
  ],
});
