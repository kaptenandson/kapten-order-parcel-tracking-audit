import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { openDB, finishJob } from "./db.js";
import { createApp } from "./app.js";
const database = resolve(process.env.DATABASE_PATH ?? "data/audit.sqlite");
const db = openDB(database);
db.prepare(
	"UPDATE jobs SET state='interrupted',error='Application restarted before job completion',completed_at=? WHERE state='running'",
).run(new Date().toISOString());
const mode = process.env.AUTH_MODE ?? "local";
if (mode !== "local" && mode !== "access") throw new Error("Invalid AUTH_MODE");
const workers = new Set<Worker>();
const port = Number(process.env.PORT ?? 3100);
const app = createApp(
	db,
	{
		mode,
		production: process.env.NODE_ENV === "production",
		origin: process.env.APP_ORIGIN ?? `http://localhost:${port}`,
		issuer: process.env.ACCESS_ISSUER,
		audience: process.env.ACCESS_AUDIENCE,
		uploadDir: resolve("data/uploads"),
		staticDir: resolve("dist/client"),
		refreshEnabled: Boolean(process.env.PARCELLAB_API_KEY_HASHED),
	},
	(id, kind, path) => {
		const worker = new Worker(new URL("./worker.js", import.meta.url), {
			workerData: { database, id, kind, path },
		});
		workers.add(worker);
		worker.on("error", () =>
			finishJob(db, id, "failed", {}, "Worker failed; previous verified data retained"),
		);
		worker.on("exit", (code) => {
			workers.delete(worker);
			if (code !== 0)
				db.prepare(
					"UPDATE jobs SET state='interrupted',error='Worker interrupted',completed_at=? WHERE id=? AND state='running'",
				).run(new Date().toISOString(), id);
		});
	},
);
const server = app.listen(port, process.env.BIND_HOST ?? "127.0.0.1", () =>
	console.log(`Audit ready on port ${port}`),
);
async function shutdown() {
	server.close();
	await Promise.all([...workers].map((w) => w.terminate()));
	db.close();
	process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
