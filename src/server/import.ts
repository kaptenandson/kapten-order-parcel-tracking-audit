import { parse } from "csv-parse/sync";
import { readSheet as readXlsxFile } from "read-excel-file/node";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { SQLInputValue, StatementSync } from "node:sqlite";
import { normalizeOrder, suffix, parcelColumns } from "../shared/contracts.js";
import { AppError, transaction, rollups, type DB } from "./db.js";
import { matchResponses, orderResolver } from "./matching.js";
export const arrayMap: Record<string, string> = {
	status_code: "parcellab_status_codes",
	status: "parcellab_statuses",
	status_timestamp: "parcellab_status_timestamps",
	latest_movement_date: "parcellab_latest_movement_date",
	last_updated: "parcellab_last_updated",
	status_step: "parcellab_status_steps",
	lifecycle: "parcellab_lifecycles",
	courier: "parcellab_couriers",
	is_delivered: "parcellab_is_delivered",
	lookup_status: "parcellab_lookup_status",
	recheck_checked_at: "parcellab_recheck_checked_at",
	recheck_result: "parcellab_recheck_result",
	recheck_error: "parcellab_recheck_error",
	refresh_checked_at: "parcellab_refresh_checked_at",
	refresh_result: "parcellab_refresh_result",
	refresh_error: "parcellab_refresh_error",
};
export const idFor = (type: string, parts: unknown[]) =>
	type + ":" + createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export function dateValue(v: unknown): string | null {
	if (v == null || v === "") return null;
	// Legacy exports have no offset. Interpret those consistently, independent of host TZ.
	if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v))
		v = v.replace(" ", "T") + "Z";
	if (typeof v !== "string" || !Number.isFinite(Date.parse(v)))
		throw new AppError(400, "Invalid source timestamp");
	return v.length === 10 ? v : new Date(v).toISOString();
}
const number = (v: unknown) => {
	if (v == null || v === "") return null;
	const n = Number(v);
	if (!Number.isFinite(n)) throw new AppError(400, "Invalid source number");
	return n;
};
function array(value: string, n?: number) {
	let a;
	try {
		a = JSON.parse(value);
	} catch {
		throw new AppError(400, "Invalid tracking JSON");
	}
	if (!Array.isArray(a) || (n !== undefined && a.length !== n))
		throw new AppError(400, "Tracking arrays must be aligned");
	return a;
}
export function importAudit(db: DB, content: Buffer) {
	let records: Record<string, string>[];
	try {
		records = parse(content, { bom: true, delimiter: ";", columns: true, skip_empty_lines: true });
	} catch {
		throw new AppError(400, "Invalid semicolon CSV");
	}
	if (!records.length) throw new AppError(400, "CSV contains no orders");
	const counts = [
		"count_RE",
		"count_active_RE",
		"count_GU",
		"count_active_GU",
		"count_WG",
		"count_active_WG",
	];
	const required = [
		"AB id",
		"projectId",
		"ab_created_at",
		"list_trackings",
		...counts,
		...Object.values(arrayMap),
	];
	if (required.some((k) => !(k in records[0])))
		throw new AppError(400, "CSV is missing required audit columns");
	const seen = new Set<string>();
	const staged: {
		order: Record<string, SQLInputValue>;
		parcels: Record<string, SQLInputValue>[];
	}[] = [];
	let excluded = 0;
	const now = new Date().toISOString();
	for (const r of records) {
		const ab = r["AB id"];
		if (!ab || seen.has(ab)) throw new AppError(400, "Missing or duplicate AB id");
		seen.add(ab);
		const created = dateValue(r.ab_created_at);
		if (!created) throw new AppError(400, "Missing AB creation date");
		if (
			!/^(6a|ks)/.test(r.projectId) ||
			created.slice(0, 10) < "2026-08-01" ||
			created.slice(0, 10) > "2026-09-10"
		) {
			excluded++;
			continue;
		}
		const orderId = idFor("order", [ab]);
		const normalized = normalizeOrder(r.projectId);
		const order: Record<string, SQLInputValue> = {
			id: orderId,
			ab_id: ab,
			projectId: r.projectId,
			ab_created_at: created,
			normalized,
			suffix: suffix(normalized),
			source_seen: now,
		};
		for (const c of counts) {
			const n = number(r[c]);
			if (n === null || n < 0 || !Number.isInteger(n))
				throw new AppError(400, "Invalid document count");
			order[c] = n;
		}
		const tracks = array(r.list_trackings);
		if (
			tracks.some((t) => typeof t !== "string" || !t.trim()) ||
			new Set(tracks).size !== tracks.length
		)
			throw new AppError(400, "Tracking references must be unique strings within an order");
		const arrays = Object.fromEntries(
			Object.entries(arrayMap).map(([k, col]) => [k, array(r[col], tracks.length)]),
		);
		const parcels = tracks.map((tracking, i) => {
			const p: Record<string, SQLInputValue> = {
				id: idFor("parcel", [ab, tracking]),
				order_id: orderId,
				ab_id: ab,
				projectId: r.projectId,
				tracking_no: tracking,
				tracking_sequence: i + 1,
				source_seen: now,
			};
			for (const [key, values] of Object.entries(arrays)) {
				const v = values[i];
				const type = parcelColumns.find((c) => c.key === key)!.type;
				if (type === "date") p[key] = dateValue(v);
				else if (type === "boolean") {
					if (v !== true && v !== false && v !== null)
						throw new AppError(400, "Delivery must be true, false or null");
					p[key] = v === null ? null : v ? 1 : 0;
				} else if (type === "number") p[key] = number(v);
				else {
					if (v !== null && typeof v !== "string") throw new AppError(400, "Invalid source text");
					p[key] = v;
				}
			}
			return p;
		});
		staged.push({ order, parcels });
	}
	transaction(db, () => {
		const statements = new Map<string, StatementSync>();
		const previousParcel = db.prepare("SELECT * FROM parcels WHERE id=?");
		const insert = (table: string, r: Record<string, SQLInputValue>) => {
			const keys = Object.keys(r);
			let statement = statements.get(table);
			if (!statement) {
				statement = db.prepare(
					`INSERT INTO ${table}(${keys.map((k) => `"${k}"`).join(",")}) VALUES(${keys.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${keys
						.filter((k) => k !== "id")
						.map((k) => `"${k}"=excluded."${k}"`)
						.join(",")}`,
				);
				statements.set(table, statement);
			}
			return statement.run(...keys.map((k) => r[k]));
		};
		for (const { order, parcels } of staged) {
			insert("orders", order);
			for (const p of parcels) {
				const old = previousParcel.get(p.id);
				if (old && String(old.last_updated ?? "") > String(p.last_updated ?? "")) {
					for (const k of Object.keys(arrayMap)) p[k] = old[k] as SQLInputValue;
				}
				insert("parcels", p);
			}
		}
		rollups(db);
		matchResponses(db);
	});
	return {
		orders: staged.length,
		parcel_references: staged.reduce((n, r) => n + r.parcels.length, 0),
		excluded,
		retained_absent_orders: (
			db.prepare("SELECT count(*) n FROM orders WHERE source_seen<>?").get(now) as { n: number }
		).n,
	};
}
export async function importResponses(db: DB, path: string) {
	const rows = await readXlsxFile(path);
	if (!rows.length) throw new AppError(400, "Empty response workbook");
	const headers = rows[0].map((x) =>
		String(x ?? "")
			.normalize("NFKC")
			.trim()
			.toLowerCase(),
	);
	const wanted = [
		"wie lautet deine bestellnummer?",
		"ich möchte eine",
		"e-mail adresse (optional)",
	];
	const positions = wanted.map((x) => headers.indexOf(x));
	if (positions.includes(-1))
		throw new AppError(400, "Response workbook is missing required columns");
	const now = new Date().toISOString();
	let skippedBlank = 0,
		skippedExisting = 0,
		skippedDuplicate = 0,
		added = 0;
	const records = rows.slice(1).flatMap((row) => {
		const vals = positions.map((i) =>
			String(row[i] ?? "")
				.normalize("NFKC")
				.trim(),
		);
		const normalized = normalizeOrder(vals[0]);
		if (!normalized) {
			skippedBlank++;
			return [];
		}
		const key = `order:${normalized}`;
		return [{ id: idFor("response", [key]), key, vals, normalized }];
	});
	transaction(db, () => {
		const up = db.prepare(
			"INSERT INTO responses(id,source_key,order_number,request_type,email,normalized,suffix,source_seen) VALUES(?,?,?,?,?,?,?,?)",
		);
		const existing = new Set(
			db
				.prepare("SELECT normalized FROM responses")
				.all()
				.map((r) => String(r.normalized)),
		);
		const seen = new Set<string>();
		const resolve = orderResolver(db);
		const identity = (value: string) => resolve(value).orderId ?? `text:${value}`;
		const existingIdentities = new Set([...existing].map(identity));
		for (const r of records) {
			const key = identity(r.normalized);
			if (existingIdentities.has(key)) {
				skippedExisting++;
				continue;
			}
			if (seen.has(key)) {
				skippedDuplicate++;
				continue;
			}
			seen.add(key);
			up.run(r.id, r.key, ...r.vals, r.normalized, suffix(r.normalized), now);
			added++;
		}
		matchResponses(db);
	});
	return {
		source_rows: rows.length - 1,
		responses: added,
		skipped_existing_orders: skippedExisting,
		skipped_duplicate_orders: skippedDuplicate,
		skipped_blank_orders: skippedBlank,
	};
}
export async function importFile(db: DB, kind: string, path: string) {
	return kind === "audit" ? importAudit(db, await readFile(path)) : importResponses(db, path);
}
