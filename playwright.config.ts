import { defineConfig, devices } from '@playwright/test';

const configuredPort = process.env.PLAYWRIGHT_PORT;

function parseConfiguredPort(value: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('PLAYWRIGHT_PORT must be an integer between 1 and 65535.');
	}
	return port;
}

const playwrightPort = configuredPort ? parseConfiguredPort(configuredPort) : undefined;

const webServer = configuredPort
	? {
			command: `npm run dev -- --host 127.0.0.1 --strictPort --port ${playwrightPort}`,
			url: `http://127.0.0.1:${playwrightPort}`,
			reuseExistingServer: false
		}
	: {
			command: 'npm run dev -- --host 127.0.0.1',
			wait: {
				stdout: /(?<playwright_test_base_url>http:\/\/127\.0\.0\.1:\d+\/)/
			},
			reuseExistingServer: false
		};

export default defineConfig({
	testDir: './tests/e2e',
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 2 : 0,
	use: {
		...(playwrightPort ? { baseURL: `http://127.0.0.1:${playwrightPort}` } : {}),
		trace: 'on-first-retry'
	},
	webServer,
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] }
		}
	]
});
