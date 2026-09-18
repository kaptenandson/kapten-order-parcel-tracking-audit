import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { matchResponses } from "./matching.js";
import { normalizeOrder, suffix } from "../shared/contracts.js";
import {
	columns,
	orderColumns,
	parcelColumns,
	type View,
	type Filter,
} from "../shared/contracts.js";
export class AppError extends Error {
	constructor(
		public status: number,
		message: string,
		public detail?: unknown,
	) {
		super(message);
	}
}
const definition = (items: typeof orderColumns) =>
	items
		.map((c) => `"${c.key}" ${c.type === "number" || c.type === "boolean" ? "REAL" : "TEXT"}`)
		.join(",");
export function openDB(path: string) {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, ${definition(orderColumns)}, normalized TEXT, suffix TEXT, source_seen TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS order_ab ON orders(ab_id);
    CREATE INDEX IF NOT EXISTS order_project ON orders(projectId);
    CREATE INDEX IF NOT EXISTS order_norm ON orders(normalized);
    CREATE INDEX IF NOT EXISTS order_suffix ON orders(suffix);
    CREATE TABLE IF NOT EXISTS parcels(id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), ${definition(parcelColumns)}, source_seen TEXT, UNIQUE(order_id,tracking_no));
    CREATE INDEX IF NOT EXISTS parcel_order ON parcels(order_id);
    CREATE INDEX IF NOT EXISTS parcel_tracking ON parcels(tracking_no);
    CREATE INDEX IF NOT EXISTS parcel_status ON parcels(status_code);
    CREATE INDEX IF NOT EXISTS parcel_delivered ON parcels(is_delivered,order_id);
    CREATE TABLE IF NOT EXISTS responses(id TEXT PRIMARY KEY, source_key TEXT UNIQUE, order_number TEXT, request_type TEXT, email TEXT, order_id TEXT REFERENCES orders(id), match_status TEXT, normalized TEXT, suffix TEXT, source_seen TEXT);
    CREATE INDEX IF NOT EXISTS response_order ON responses(order_id);
    CREATE TABLE IF NOT EXISTS notes(entity TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL, editor TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, report TEXT NOT NULL DEFAULT '{}', error TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs((1)) WHERE state='running';
    CREATE VIEW IF NOT EXISTS requests AS SELECT r.id || ':' || COALESCE(p.id,'none') AS id, r.id AS note_id, r.order_number,r.request_type,r.email,p.tracking_no,
      CASE WHEN r.match_status='ambiguous' THEN 'Ambiguous order match' WHEN r.order_id IS NULL THEN 'Order not found in audit' WHEN p.id IS NULL THEN 'No tracking found in Actindo LI documents' WHEN p.lookup_status NOT LIKE 'matched%' OR p.lookup_status IS NULL THEN 'No parcelLab match' WHEN COALESCE(p.status_code,'')<>'' AND COALESCE(p.status,'')<>'' AND lower(p.status_code)<>lower(p.status) THEN p.status_code || ' - ' || p.status ELSE COALESCE(NULLIF(p.status_code,''),NULLIF(p.status,''),'No parcel status') END AS latest_status,
      p.last_updated,r.order_id,r.source_seen FROM responses r LEFT JOIN parcels p ON p.order_id=r.order_id;
  `);
	if (Number(db.prepare("PRAGMA user_version").get()!.user_version) < 1) {
		transaction(db, () => {
			const update = db.prepare("UPDATE orders SET normalized=?,suffix=? WHERE id=?");
			for (const r of db.prepare("SELECT id,projectId FROM orders").all()) {
				const value = normalizeOrder(r.projectId);
				update.run(value, suffix(value), r.id);
			}
			matchResponses(db);
			db.exec(`DROP VIEW requests;
			CREATE VIEW requests AS SELECT r.id || ':' || COALESCE(p.id,'none') AS id,r.id AS note_id,r.order_number,
			COALESCE(o.normalized,r.normalized) AS normalized_matcher,r.match_status,r.request_type,r.email,p.tracking_no,
			CASE WHEN r.match_status='ambiguous' THEN 'Ambiguous order match' WHEN r.order_id IS NULL THEN 'Order not found in audit' WHEN p.id IS NULL THEN 'No tracking found in Actindo LI documents' WHEN p.lookup_status NOT LIKE 'matched%' OR p.lookup_status IS NULL THEN 'No parcelLab match' WHEN COALESCE(p.status_code,'')<>'' AND COALESCE(p.status,'')<>'' AND lower(p.status_code)<>lower(p.status) THEN p.status_code || ' - ' || p.status ELSE COALESCE(NULLIF(p.status_code,''),NULLIF(p.status,''),'No parcel status') END AS latest_status,
			p.last_updated,r.order_id,r.source_seen FROM responses r LEFT JOIN orders o ON o.id=r.order_id LEFT JOIN parcels p ON p.order_id=r.order_id;
			PRAGMA user_version=1;`);
		});
	}
	return db;
}
export type DB = ReturnType<typeof openDB>;
export function transaction<T>(db: DB, fn: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const value = fn();
		db.exec("COMMIT");
		return value;
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
}
export function query(db: DB, view: View, params: URLSearchParams, filters: readonly Filter[]) {
	const cols = columns[view];
	const names = new Map(cols.map((c) => [c.key, c]));
	const expr = (key: string) => (key === "notes" ? "COALESCE(n.text,'')" : `v."${key}"`);
	const clauses: string[] = [];
	const args: SQLInputValue[] = [];
	const escape = (s: string) => s.replace(/[\\%_]/g, "\\$&");
	for (const f of filters) {
		const c = names.get(f.column);
		if (!c) throw new AppError(400, "Unknown filter column");
		const x = expr(f.column);
		const val = f.value ?? "";
		if (f.op === "empty" || f.op === "notempty") {
			clauses.push(
				`(${x} IS ${f.op === "empty" ? "" : "NOT "}NULL ${f.op === "empty" ? "OR" : "AND"} ${x}${f.op === "empty" ? "=" : "<>"}'')`,
			);
			continue;
		}
		if (f.op === "contains") {
			if (c.type !== "text") throw new AppError(400, "Contains requires a text column");
			clauses.push(`${x} LIKE ? ESCAPE '\\'`);
			args.push(`%${escape(val)}%`);
			continue;
		}
		const convert = (v: string): SQLInputValue => {
			if (c.type === "number") {
				if (v.trim() === "" || !Number.isFinite(Number(v)))
					throw new AppError(400, "Invalid number");
				return Number(v);
			}
			if (c.type === "boolean") {
				if (!["true", "false", "1", "0"].includes(v)) throw new AppError(400, "Invalid boolean");
				return v === "true" || v === "1" ? 1 : 0;
			}
			if (c.type === "date") {
				if (!Number.isFinite(Date.parse(v))) throw new AppError(400, "Invalid date");
				return v.length === 10 ? v : new Date(v).toISOString();
			}
			return v;
		};
		if (f.op === "in") {
			const values = val.split("|");
			if (values.length > 50) throw new AppError(400, "Too many values");
			clauses.push(`${x} IN (${values.map(() => "?").join(",")})`);
			args.push(...values.map(convert));
		} else {
			if (["gte", "lte"].includes(f.op) && !["number", "date"].includes(c.type))
				throw new AppError(400, "Ranges require a date or number");
			const comparison =
				c.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(val) ? `substr(${x},1,10)` : x;
			clauses.push(`${comparison} ${{ eq: "=", gte: ">=", lte: "<=" }[f.op]} ?`);
			args.push(convert(val));
		}
	}
	const search = (params.get("q") ?? "").slice(0, 200);
	if (search) {
		clauses.push(
			`(${cols.map((c) => `CAST(${expr(c.key)} AS TEXT) LIKE ? ESCAPE '\\'`).join(" OR ")})`,
		);
		args.push(...cols.map(() => `%${escape(search)}%`));
	}
	const linked = params.get("orderId");
	if (linked) {
		clauses.push(view === "orders" ? "v.id=?" : "v.order_id=?");
		args.push(linked);
	}
	const sort = params.get("sort") ?? cols[0].key;
	if (!names.has(sort)) throw new AppError(400, "Unknown sort column");
	const direction = params.get("direction") ?? "asc";
	if (!["asc", "desc"].includes(direction)) throw new AppError(400, "Invalid sort direction");
	const page = Number(params.get("page") ?? 1),
		pageSize = Number(params.get("pageSize") ?? 50);
	if (
		!Number.isSafeInteger(page) ||
		page < 1 ||
		page > 100000 ||
		!Number.isSafeInteger(pageSize) ||
		pageSize < 1 ||
		pageSize > 200
	)
		throw new AppError(400, "Invalid pagination");
	const noteId = view === "requests" ? "v.note_id" : "v.id";
	const from = `FROM ${view} v LEFT JOIN notes n ON n.entity=${noteId}`;
	const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
	const total = (
		db.prepare(`SELECT count(*) AS total ${from} ${where}`).get(...args) as { total: number }
	).total;
	const rows = db
		.prepare(
			`SELECT v.*,${noteId} AS note_id,COALESCE(n.text,'') AS notes,COALESCE(n.revision,0) AS note_revision ${from} ${where} ORDER BY ${expr(sort)} ${direction},v.id ASC LIMIT ? OFFSET ?`,
		)
		.all(...args, pageSize, (page - 1) * pageSize);
	return { rows, total, page, pageSize, columns: cols };
}
export function entityExists(db: DB, id: string) {
	return ["orders", "parcels", "responses"].some((t) =>
		db.prepare(`SELECT 1 FROM ${t} WHERE id=?`).get(id),
	);
}
export function getNote(db: DB, id: string) {
	if (!entityExists(db, id)) throw new AppError(404, "Record not found");
	return (
		db.prepare("SELECT text,revision,editor,updated_at FROM notes WHERE entity=?").get(id) ?? {
			text: "",
			revision: 0,
			editor: null,
			updated_at: null,
		}
	);
}
export function saveNote(db: DB, id: string, text: string, revision: number, editor: string) {
	return transaction(db, () => {
		const previous = getNote(db, id) as { revision: number };
		if (previous.revision !== revision)
			throw new AppError(409, "Another employee changed this note", previous);
		db.prepare(
			"INSERT INTO notes VALUES(?,?,?,?,?) ON CONFLICT(entity) DO UPDATE SET text=excluded.text,revision=excluded.revision,editor=excluded.editor,updated_at=excluded.updated_at",
		).run(id, text, revision + 1, editor, new Date().toISOString());
		return getNote(db, id);
	});
}
export function startJob(db: DB, kind: string) {
	const id = randomUUID();
	try {
		db.prepare("INSERT INTO jobs(id,kind,state,started_at) VALUES(?,?,'running',?)").run(
			id,
			kind,
			new Date().toISOString(),
		);
	} catch {
		throw new AppError(409, "An import or refresh is already running");
	}
	return id;
}
export function finishJob(
	db: DB,
	id: string,
	state: string,
	report: unknown,
	error: string | null = null,
) {
	db.prepare("UPDATE jobs SET state=?,report=?,error=?,completed_at=? WHERE id=?").run(
		state,
		JSON.stringify(report),
		error,
		new Date().toISOString(),
		id,
	);
}
export function rollups(db: DB) {
	db.exec(`UPDATE orders SET tracking_count=(SELECT count(*) FROM parcels WHERE order_id=orders.id),matched_tracking_count=(SELECT count(*) FROM parcels WHERE order_id=orders.id AND lookup_status LIKE 'matched%'),delivered_tracking_count=(SELECT count(*) FROM parcels WHERE order_id=orders.id AND is_delivered=1),exception_tracking_count=(SELECT count(*) FROM parcels WHERE order_id=orders.id AND lower(status_code)='exception'),latest_movement_date=(SELECT max(latest_movement_date) FROM parcels WHERE order_id=orders.id),latest_parcellab_update_at=(SELECT max(last_updated) FROM parcels WHERE order_id=orders.id);
 UPDATE orders SET unresolved_tracking_count=tracking_count-matched_tracking_count,tracking_coverage=CASE WHEN tracking_count=0 THEN 'No tracking' WHEN matched_tracking_count=tracking_count THEN 'Complete' WHEN matched_tracking_count=0 THEN 'Unresolved' ELSE 'Partial' END,delivery_rollup=CASE WHEN tracking_count=0 THEN 'No tracking' WHEN delivered_tracking_count=tracking_count THEN 'All delivered' WHEN delivered_tracking_count>0 THEN 'Partially delivered' ELSE 'Not delivered' END;`);
}
