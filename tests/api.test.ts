import { afterEach, beforeEach, describe, it, expect } from "vitest";
import request from "supertest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import writeXlsxFile from "write-excel-file/node";
import { createApp, type Config } from "../src/server/app.js";
import { openDB, finishJob, type DB } from "../src/server/db.js";
import { importFile, dateValue } from "../src/server/import.js";
import { refresh, type Provider, tomorrow } from "../src/server/refresh.js";
import { auditRow, csv, raw } from "./fixtures.js";
let db: DB, dir: string, app: ReturnType<typeof createApp>, provider: Provider;
const origin = "http://localhost:3100";
const headers = { Origin: origin, "X-Audit-Request": "1" };
const config = (): Config => ({
	mode: "local",
	production: false,
	origin,
	uploadDir: dir,
	refreshEnabled: true,
});
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "audit-test-"));
	db = openDB(join(dir, "audit.sqlite"));
	provider = { pageSize: 10000, page: async () => ({ results: [raw("000123")] }) };
	app = createApp(db, config(), (id, kind, path) => {
		setImmediate(async () => {
			try {
				const report =
					kind === "refresh" ? await refresh(db, provider) : await importFile(db, kind, path!);
				finishJob(db, id, "completed", report);
			} catch (e) {
				finishJob(db, id, "failed", {}, (e as Error).message);
			}
		});
	});
});
afterEach(async () => {
	db.close();
	await rm(dir, { recursive: true, force: true });
});
async function waitJob(id: string) {
	let state: any;
	await expect
		.poll(async () => {
			const r = await request(app).get("/api/jobs");
			state = r.body.jobs.find((j: any) => j.id === id);
			return state?.state;
		})
		.not.toBe("running");
	return state;
}
async function upload(rows = [auditRow()]) {
	const r = await request(app)
		.post("/api/import/audit")
		.set(headers)
		.set("Content-Type", "text/csv")
		.send(csv(rows));
	expect(r.status).toBe(202);
	return waitJob(r.body.id);
}
describe("Application API and durable storage", () => {
	it("interprets legacy timestamps consistently and includes whole days in date filters", async () => {
		expect(dateValue("2026-08-01 00:06:09")).toBe("2026-08-01T00:06:09.000Z");
		const row = auditRow();
		row.ab_created_at = "2026-09-10 23:59:59";
		expect((await upload([row])).state).toBe("completed");
		for (const op of ["eq", "lte", "gte"]) {
			const result = await request(app)
				.get("/api/tables/orders")
				.query({ filters: JSON.stringify([{ column: "ab_created_at", op, value: "2026-09-10" }]) });
			expect(result.body.total).toBe(1);
		}
	});
	it("imports, searches, filters, saves notes and refreshes siblings without losing notes", async () => {
		expect((await upload()).state).toBe("completed");
		const rows = (await request(app).get("/api/tables/parcels")).body.rows;
		expect(rows[0].tracking_no).toBe("000123");
		const noteUrl = "/api/notes/" + encodeURIComponent(rows[0].note_id);
		expect(
			(
				await request(app)
					.put(noteUrl)
					.set(headers)
					.send({ text: "Called customer — déjà vu", revision: 0 })
			).status,
		).toBe(200);
		expect((await request(app).get("/api/tables/parcels").query({ q: "déjà" })).body.total).toBe(1);
		expect(
			(
				await request(app)
					.get("/api/tables/orders")
					.query({ filters: JSON.stringify([{ column: "count_RE", op: "gte", value: "2" }]) })
			).body.total,
		).toBe(1);
		const r = await request(app).post("/api/refresh").set(headers);
		const job = await waitJob(r.body.id);
		expect(job.report).toMatchObject({
			eligible_orders: 1,
			tracking_references: 2,
			delivered_siblings: 1,
			bulk_misses: 1,
			newly_delivered: 1,
		});
		const parcels = (await request(app).get("/api/tables/parcels")).body.rows;
		expect(parcels[0].is_delivered).toBe(1);
		expect(parcels[1].status_code).toBe("Delivered");
		expect(parcels[1].refresh_result).toBe("not_found_bulk_refresh");
		expect((await request(app).get(noteUrl)).body.text).toContain("déjà");
		await upload();
		expect((await request(app).get("/api/tables/parcels")).body.rows[0].is_delivered).toBe(1);
		expect((await request(app).get(noteUrl)).body.text).toContain("déjà");
	});
	it("retains stable parcel notes when source tracking arrays reorder and prevents stale note overwrites", async () => {
		await upload();
		const row = (await request(app).get("/api/tables/parcels")).body.rows[0];
		const url = "/api/notes/" + encodeURIComponent(row.note_id);
		const responses = await Promise.all([
			request(app).put(url).set(headers).send({ text: "A", revision: 0 }),
			request(app).put(url).set(headers).send({ text: "B", revision: 0 }),
		]);
		expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
		await upload([auditRow("1", "ksde-1001-1234567", ["000456", "000123"])]);
		expect(
			(await request(app).get("/api/tables/parcels").query({ q: "000123" })).body.rows[0].note_id,
		).toBe(row.note_id);
		expect((await request(app).get(url)).body.revision).toBe(1);
		db.close();
		db = openDB(join(dir, "audit.sqlite"));
		expect(db.prepare("SELECT revision FROM notes WHERE entity=?").get(row.note_id)?.revision).toBe(
			1,
		);
	});
	it("rejects malformed arrays atomically and excludes out-of-scope orders", async () => {
		await upload();
		const bad = auditRow("2");
		bad.parcellab_statuses = "[]";
		expect((await upload([auditRow("3"), bad])).state).toBe("failed");
		expect((await request(app).get("/api/tables/orders")).body.total).toBe(1);
		expect((await upload([auditRow("4", "other")])).report.excluded).toBe(1);
	});
	it("rolls back a failed later page and serializes jobs while permitting notes", async () => {
		await upload();
		let release!: () => void;
		provider = {
			pageSize: 1,
			page: async (p) => {
				if (p === 0) return { results: [raw("000123")] };
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				throw new Error("network failed");
			},
		};
		const r = await request(app).post("/api/refresh").set(headers);
		await expect.poll(() => typeof release).toBe("function");
		expect((await request(app).post("/api/refresh").set(headers)).status).toBe(409);
		const row = (await request(app).get("/api/tables/orders")).body.rows[0];
		expect(
			(
				await request(app)
					.put("/api/notes/" + encodeURIComponent(row.id))
					.set(headers)
					.send({ text: "Still working", revision: 0 })
			).status,
		).toBe(200);
		release();
		expect((await waitJob(r.body.id)).state).toBe("failed");
		expect((await request(app).get("/api/tables/parcels")).body.rows[0].status_code).toBe(
			"InTransit",
		);
	});
	it("skips existing order numbers, deduplicates a workbook and expands all sibling parcels", async () => {
		await upload();
		const file = join(dir, "responses.xlsx");
		await writeXlsxFile(
			[
				["Wie lautet deine Bestellnummer?", "Ich möchte eine", "E-Mail Adresse (optional)"],
				[" KSDE10011234567 ", "Changed request", "different@example.com"],
				["ksde-1001-1234567", "Ersatzlieferung", "test@example.com"],
				["ksde-1001-9999999", "Erstattung", ""],
			].map((r) => r.map((value) => ({ value, type: String }))),
		).toFile(file);
		const send = async () => {
			const r = await request(app)
				.post("/api/import/responses")
				.set(headers)
				.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
				.send(await readFile(file));
			expect(r.status).toBe(202);
			const job = await waitJob(r.body.id);
			expect(job.state).toBe("completed");
			return job.report;
		};
		expect(await send()).toMatchObject({ responses: 2, skipped_duplicate_orders: 1 });
		const before = db.prepare("SELECT * FROM responses ORDER BY id").all();
		const entity = String(before[0].id);
		await request(app)
			.put("/api/notes/" + encodeURIComponent(entity))
			.set(headers)
			.send({ text: "Keep this note", revision: 0 });
		expect(await send()).toMatchObject({ responses: 0, skipped_existing_orders: 3 });
		expect(db.prepare("SELECT * FROM responses ORDER BY id").all()).toEqual(before);
		expect((await request(app).get("/api/notes/" + encodeURIComponent(entity))).body.text).toBe(
			"Keep this note",
		);
		const result = (await request(app).get("/api/tables/requests")).body;
		expect(result.total).toBe(3);
		const matched = result.rows.filter((r: any) => r.tracking_no);
		expect(new Set(matched.map((r: any) => r.note_id)).size).toBe(1);
		expect(matched[0].last_updated).toBe("2026-09-17T12:00:00.000Z");
		expect(result.rows.find((r: any) => !r.tracking_no).latest_status).toBe(
			"Order not found in audit",
		);
	});
	it("validates filters, note lengths and same-origin writes", async () => {
		await upload();
		expect(
			(await request(app).get("/api/tables/orders").query({ sort: "id; DROP TABLE notes" })).status,
		).toBe(400);
		expect((await request(app).get("/api/tables/orders").query({ filters: "bad" })).status).toBe(
			400,
		);
		expect((await request(app).post("/api/refresh")).status).toBe(403);
		const row = (await request(app).get("/api/tables/orders")).body.rows[0];
		expect(
			(
				await request(app)
					.put("/api/notes/" + encodeURIComponent(row.id))
					.set(headers)
					.send({ text: "x".repeat(10001), revision: 0 })
			).status,
		).toBe(400);
	});
	it("requires a verified Access token and refuses production local mode", async () => {
		expect(() => createApp(db, { ...config(), production: true }, () => {})).toThrow();
		const secured = createApp(
			db,
			{ ...config(), mode: "access" },
			() => {},
			async (token) => {
				if (token !== "valid") throw Error();
				return "employee@example.com";
			},
		);
		expect((await request(secured).get("/api/tables/orders")).status).toBe(401);
		expect(
			(await request(secured).get("/api/tables/orders").set("Cf-Access-Jwt-Assertion", "forged"))
				.status,
		).toBe(401);
		expect(
			(await request(secured).get("/api/meta").set("Cf-Access-Jwt-Assertion", "valid")).body.actor,
		).toBe("employee@example.com");
	});
	it("computes tomorrow in Berlin across UTC midnight", () => {
		expect(tomorrow(new Date("2026-09-18T23:30:00Z"))).toBe("2026-09-20");
	});
});
