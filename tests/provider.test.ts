import { afterEach, it, expect, vi } from "vitest";
import { provider, refresh } from "../src/server/refresh.js";
import { openDB } from "../src/server/db.js";
import { importAudit } from "../src/server/import.js";
import { auditRow, csv, raw } from "./fixtures.js";
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
it("spaces pages and retries sequentially and respects Retry-After", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
	const starts: number[] = [];
	const urls: string[] = [];
	let count = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: URL) => {
			starts.push(Date.now());
			urls.push(url.toString());
			return count++ === 0
				? new Response("{}", { status: 429, headers: { "Retry-After": "2" } })
				: new Response('{"results":[]}');
		}),
	);
	const api = provider("test-only");
	const first = api.page(0, "2026-08-01", "2026-09-19");
	await vi.runAllTimersAsync();
	await first;
	const second = api.page(1, "2026-08-01", "2026-09-19");
	await vi.runAllTimersAsync();
	await second;
	expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(2000);
	expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(1000);
	expect(urls[0]).toContain("/v2/search?");
	expect(urls[0]).not.toContain("live_refresh");
	expect(urls[2]).toContain("p=1");
});
it("does not retry authentication failures or expose credentials", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 401 })),
	);
	await expect(provider("secret-test-value").page(0, "2026-08-01", "2026-09-19")).rejects.toThrow(
		"authentication failed",
	);
	expect(fetch).toHaveBeenCalledTimes(1);
});
it("skips final orders, deduplicates shared tracking targets, and preserves newer verified statuses", async () => {
	const db = openDB(":memory:");
	try {
		const finished = auditRow("3", "ksde-1001-1234569", ["finished"]);
		finished.parcellab_is_delivered = "[true]";
		finished.parcellab_status_codes = '["Delivered"]';
		importAudit(db, csv([auditRow("1"), auditRow("2", "ksde-1001-1234568"), finished]));
		const report = await refresh(db, {
			pageSize: 10000,
			page: async () => ({
				results: [raw("000123", "Exception", "2026-09-01T00:00:00Z"), raw("000456")],
			}),
		});
		expect(report).toMatchObject({
			eligible_orders: 2,
			tracking_references: 4,
			unique_tracking_codes: 2,
			stale_records: 2,
		});
		expect(
			db.prepare("SELECT status_code FROM parcels WHERE tracking_no='000123'").get()?.status_code,
		).toBe("InTransit");
		expect(
			db.prepare("SELECT refresh_checked_at FROM parcels WHERE tracking_no='finished'").get()
				?.refresh_checked_at,
		).toBe(null);
	} finally {
		db.close();
	}
});
