import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: "tests/browser",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	use: { baseURL: "http://localhost:3199", headless: true },
	webServer: {
		command: "npm run build && node dist/server/main.js",
		url: "http://localhost:3199/health",
		reuseExistingServer: false,
		env: {
			PORT: "3199",
			DATABASE_PATH: "data/browser-test.sqlite",
			APP_ORIGIN: "http://localhost:3199",
			AUTH_MODE: "local",
			NODE_ENV: "test",
		},
	},
});
