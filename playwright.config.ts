import { defineConfig } from '@playwright/test'

export default defineConfig({ testDir: 'e2e', globalSetup: './e2e/global-setup.ts', timeout: 60_000, retries: process.env.CI ? 1 : 0 })
