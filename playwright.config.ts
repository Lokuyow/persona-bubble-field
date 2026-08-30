import { defineConfig, devices } from '@playwright/test';

const configuredPort = process.env.PLAYWRIGHT_PORT;

function parseConfiguredPort(value: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('PLAYWRIGHT_PORT must be an integer between 1 and 65535.');
	}
	return port;
}

function resolvePlaywrightPort(): number {
	if (configuredPort) return parseConfiguredPort(configuredPort);

	// Playwright evaluates this config in the runner and in each worker. A
	// worktree-derived port keeps those processes aligned without relying on a
	// shared fixed default or a temporary cross-process file.
	let hash = 2166136261;
	for (const character of process.cwd().toLowerCase()) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return 49152 + (hash >>> 0) % (65535 - 49152 + 1);
}

const playwrightPort = resolvePlaywrightPort();

export default defineConfig({
	testDir: './tests/e2e',
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 2 : 0,
	use: {
		baseURL: `http://127.0.0.1:${playwrightPort}`,
		trace: 'on-first-retry'
	},
	webServer: {
		command: `npm run dev -- --host 127.0.0.1 --strictPort --port ${playwrightPort}`,
		url: `http://127.0.0.1:${playwrightPort}`,
		reuseExistingServer: false
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] }
		}
	]
});
