import { workerData, parentPort } from "node:worker_threads";
import { unlink } from "node:fs/promises";
import { Effect } from "effect";
import { openDB, finishJob, AppError } from "./db.js";
import { importFile } from "./import.js";
import { provider, refresh } from "./refresh.js";
const { database, id, kind, path } = workerData;
const db = openDB(database);
await Effect.runPromise(
	Effect.tryPromise({
		try: async () => {
			const result =
				kind === "refresh"
					? await refresh(db, provider(process.env.PARCELLAB_API_KEY_HASHED ?? ""), (report) =>
							db.prepare("UPDATE jobs SET report=? WHERE id=?").run(JSON.stringify(report), id),
						)
					: await importFile(db, kind, path);
			finishJob(db, id, "completed", result);
		},
		catch: (e) => e,
	}).pipe(
		Effect.catchAll((e) =>
			Effect.sync(() =>
				finishJob(
					db,
					id,
					"failed",
					{},
					e instanceof AppError ? e.message : "Source validation or processing failed",
				),
			),
		),
	),
);
if (path) await unlink(path).catch(() => {});
db.close();
parentPort?.postMessage("complete");
