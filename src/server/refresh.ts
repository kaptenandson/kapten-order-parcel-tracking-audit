import { Effect } from "effect";
import { AppError, transaction, rollups, type DB } from "./db.js";
import { dateValue } from "./import.js";
export const BULK_URL = "https://api.parcellab.com/v2/search";
type Snapshot = {
	status_code: string | null;
	status: string | null;
	status_timestamp: string | null;
	last_updated: string | null;
	status_step: number | null;
	lifecycle: string | null;
	courier: string | null;
	is_delivered: number | null;
	latest_movement_date: string | null;
};
export type Provider = {
	page: (page: number, from: string, to: string) => Promise<unknown>;
	pageSize: number;
};
export function tomorrow(now = new Date()) {
	const s = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Europe/Berlin",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);
	const d = new Date(s + "T12:00:00Z");
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
}
export function provider(token: string): Provider {
	let last = 0;
	return {
		pageSize: 10000,
		async page(page, from, to) {
			for (let attempt = 0; attempt < 5; attempt++) {
				await Effect.runPromise(Effect.sleep(Math.max(0, 1000 - (Date.now() - last))));
				last = Date.now();
				try {
					const url = new URL(BULK_URL);
					url.search = new URLSearchParams({
						from,
						to,
						p: String(page),
						pSize: "10000",
					}).toString();
					const response = await fetch(url, {
						headers: {
							Authorization: `Parcellab-API-Token ${token}`,
							"x-plugin-type": "zendesk",
							Accept: "application/json",
						},
						signal: AbortSignal.timeout(180000),
					});
					if (response.ok) return await response.json();
					if (response.status === 401 || response.status === 403)
						throw new AppError(502, "parcelLab authentication failed");
					if (response.status !== 429 && response.status < 500)
						throw new AppError(502, `parcelLab HTTP ${response.status}`);
					if (attempt === 4) throw new AppError(502, "parcelLab retry limit reached");
					const retry = response.headers.get("retry-after");
					const delay = retry
						? Number.isFinite(Number(retry))
							? Number(retry) * 1000
							: Date.parse(retry) - Date.now()
						: 1000 * 2 ** attempt;
					if (delay > 300000)
						throw new AppError(502, "parcelLab requested a longer pause; retry this run later");
					await Effect.runPromise(Effect.sleep(Math.max(1000, delay || 1000)));
				} catch (e) {
					if (e instanceof AppError) throw e;
					if (attempt === 4) throw new AppError(502, "parcelLab network request failed");
					await Effect.runPromise(Effect.sleep(1000 * 2 ** attempt));
				}
			}
			throw new AppError(502, "parcelLab request failed");
		},
	};
}
function snapshot(raw: unknown): { tracking: string; value: Snapshot } | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, any>;
	if (typeof r.tn !== "string" || !r.tn.trim()) return null;
	const st = r.lst?.sta ?? {};
	const text = (v: unknown) => (v == null ? null : String(v));
	const code = text(st.code),
		status = text(st.status),
		life = text(st.lifecycle);
	const delivered = [code, status, life].some((v) => v?.toLowerCase() === "delivered");
	const timestamp = dateValue(st.timestamp);
	return {
		tracking: r.tn.trim(),
		value: {
			status_code: code,
			status,
			status_timestamp: timestamp,
			last_updated: dateValue(r.lst?.dat),
			status_step: st.step == null ? null : Number(st.step),
			lifecycle: life,
			courier:
				typeof r.co === "string"
					? r.co
					: text(r.co?.n ?? r.co?.code ?? r.co?.key ?? r.co?.name ?? r.co?.courier ?? r.co?.p),
			is_delivered: delivered ? 1 : code || status || life ? 0 : null,
			latest_movement_date: timestamp?.slice(0, 10) ?? null,
		},
	};
}
export async function refresh(db: DB, api: Provider, progress: (x: unknown) => void = () => {}) {
	const selected = db
		.prepare(
			"SELECT p.* FROM parcels p WHERE EXISTS(SELECT 1 FROM parcels sibling WHERE sibling.order_id=p.order_id AND sibling.is_delivered IS NOT 1)",
		)
		.all();
	const targets = new Set(selected.map((r) => String(r.tracking_no)));
	const statuses = new Map<string, Snapshot>();
	const report = {
		eligible_orders: new Set(selected.map((r) => r.order_id)).size,
		tracking_references: selected.length,
		delivered_siblings: selected.filter((r) => r.is_delivered === 1).length,
		unique_tracking_codes: targets.size,
		records_scanned: 0,
		pages: 0,
		matched_tracking_numbers: 0,
		bulk_misses: 0,
		status_changes: 0,
		newly_delivered: 0,
		stale_records: 0,
		final_delivered: 0,
		final_exceptions: 0,
		completion_utc: "",
	};
	if (targets.size)
		for (let p = 0; ; p++) {
			const payload = await api.page(p, "2026-08-01", tomorrow());
			if (!payload || typeof payload !== "object" || !Array.isArray((payload as any).results))
				throw new AppError(502, "Malformed parcelLab bulk response");
			const rows = (payload as { results: unknown[] }).results;
			report.records_scanned += rows.length;
			report.pages++;
			for (const raw of rows) {
				const result = snapshot(raw);
				if (!result || !targets.has(result.tracking)) continue;
				const old = statuses.get(result.tracking);
				if (
					!old ||
					(result.value.status_timestamp ?? result.value.last_updated ?? "") >=
						(old.status_timestamp ?? old.last_updated ?? "")
				)
					statuses.set(result.tracking, result.value);
			}
			progress({ ...report, matched_tracking_numbers: statuses.size });
			if (rows.length < api.pageSize) break;
		}
	report.matched_tracking_numbers = statuses.size;
	report.bulk_misses = targets.size - statuses.size;
	const now = new Date().toISOString();
	transaction(db, () => {
		for (const old of selected) {
			const record = statuses.get(String(old.tracking_no));
			if (!record) {
				db.prepare(
					"UPDATE parcels SET refresh_checked_at=?,refresh_result='not_found_bulk_refresh',refresh_error=NULL WHERE id=?",
				).run(now, old.id);
				continue;
			}
			if (String(old.last_updated ?? "") > String(record.last_updated ?? "")) {
				report.stale_records++;
				db.prepare(
					"UPDATE parcels SET refresh_checked_at=?,refresh_result='preserved_newer_verified_data',refresh_error=NULL WHERE id=?",
				).run(now, old.id);
				continue;
			}
			if (record.status_code !== old.status_code) report.status_changes++;
			if (old.is_delivered !== 1 && record.is_delivered === 1) report.newly_delivered++;
			const keys = Object.keys(record) as (keyof Snapshot)[];
			db.prepare(
				`UPDATE parcels SET ${keys.map((k) => `"${k}"=?`).join(",")},lookup_status='matched_bulk_refresh',refresh_result='matched_bulk_refresh',refresh_error=NULL,refresh_checked_at=? WHERE id=?`,
			).run(...keys.map((k) => record[k]), now, old.id);
		}
		rollups(db);
	});
	report.final_delivered = Number(
		db.prepare("SELECT count(*) n FROM parcels WHERE is_delivered=1").get()!.n,
	);
	report.final_exceptions = Number(
		db.prepare("SELECT count(*) n FROM parcels WHERE lower(status_code)='exception'").get()!.n,
	);
	report.completion_utc = now;
	return report;
}
