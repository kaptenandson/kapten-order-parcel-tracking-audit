import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openDB, transaction, query, saveNote } from "../src/server/db.js";
const dir = mkdtempSync(join(tmpdir(), "audit-benchmark-"));
const db = openDB(join(dir, "audit.sqlite"));
transaction(db, () => {
	const o = db.prepare("INSERT INTO orders(id,ab_id,projectId,count_RE) VALUES(?,?,?,?)");
	const p = db.prepare(
		"INSERT INTO parcels(id,order_id,ab_id,projectId,tracking_no,status_code,is_delivered) VALUES(?,?,?,?,?,?,?)",
	);
	for (let i = 0; i < 200000; i++) {
		o.run("o" + i, String(i), "ksde-1001-" + (1000000 + i), i % 3);
		p.run(
			"p" + i,
			"o" + i,
			String(i),
			"ksde-1001-" + (1000000 + i),
			"000" + i,
			i % 10 === 0 ? "Exception" : "Delivered",
			i % 10 === 0 ? 0 : 1,
		);
	}
});
const results: Record<string, number> = {};
for (const [name, fn] of Object.entries({
	indexed: () =>
		query(db, "parcels", new URLSearchParams(), [
			{ column: "tracking_no", op: "eq", value: "0001234" },
		]),
	contains: () => query(db, "orders", new URLSearchParams("q=1234"), []),
	numeric: () =>
		query(db, "orders", new URLSearchParams(), [{ column: "count_RE", op: "gte", value: "2" }]),
	note: () => {
		const r = db.prepare("SELECT revision FROM notes WHERE entity=?").get("o1");
		saveNote(db, "o1", "benchmark", Number(r?.revision ?? 0), "benchmark");
	},
})) {
	const times = [];
	for (let n = 0; n < 20; n++) {
		const start = performance.now();
		fn();
		times.push(performance.now() - start);
	}
	times.sort((a, b) => a - b);
	results[name + "_p95_ms"] = Math.round(times[18] * 10) / 10;
}
console.log(JSON.stringify({ orders: 200000, parcels: 200000, ...results }));
db.close();
rmSync(dir, { recursive: true, force: true });
if (results.indexed_p95_ms > 1000 || results.numeric_p95_ms > 1000 || results.note_p95_ms > 500)
	process.exitCode = 1;
