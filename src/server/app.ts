import express, { type Request, type Response, type NextFunction } from "express";
import { Effect, Schema } from "effect";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { columns, FilterInput, NoteInput, type View } from "../shared/contracts.js";
import { AppError, query, getNote, saveNote, startJob, finishJob, type DB } from "./db.js";
export type Config = {
	mode: "local" | "access";
	origin: string;
	production: boolean;
	issuer?: string;
	audience?: string;
	uploadDir: string;
	staticDir?: string;
	refreshEnabled: boolean;
};
export type Launch = (id: string, kind: string, path?: string) => void;
const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) => {
	try {
		return Schema.decodeUnknownSync(schema)(input);
	} catch {
		throw new AppError(400, "Invalid request fields");
	}
};
export function createApp(
	db: DB,
	config: Config,
	launch: Launch,
	verifyToken?: (token: string) => Promise<string>,
) {
	if (config.mode === "local" && config.production)
		throw new Error("Local access mode is forbidden in production");
	if (config.mode === "access" && (!config.issuer || !config.audience) && !verifyToken)
		throw new Error("Access issuer and audience are required");
	const jwks =
		config.mode === "access" && !verifyToken
			? createRemoteJWKSet(new URL("/cdn-cgi/access/certs", config.issuer))
			: null;
	const app = express();
	app.disable("x-powered-by");
	app.use((_req, res, next) => {
		res.set({
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "same-origin",
			"Content-Security-Policy":
				"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
			"Cache-Control": "no-store",
		});
		next();
	});
	app.get("/health", (_req, res) => {
		db.prepare("SELECT 1").get();
		res.json({ status: "ok" });
	});
	app.use("/api", async (req, res, next) => {
		try {
			let actor = "local-developer";
			if (config.mode === "access") {
				const token = req.header("Cf-Access-Jwt-Assertion");
				if (!token) throw new AppError(401, "Access authentication required");
				try {
					if (verifyToken) actor = await verifyToken(token);
					else {
						const { payload } = await jwtVerify(token, jwks!, {
							issuer: config.issuer,
							audience: config.audience,
							algorithms: ["RS256"],
						});
						if (!payload.exp || !payload.sub) throw new Error("Missing token claims");
						actor = String(payload.email ?? payload.sub);
					}
				} catch {
					throw new AppError(401, "Invalid Access token");
				}
			}
			if (
				!["GET", "HEAD", "OPTIONS"].includes(req.method) &&
				(req.header("Origin") !== config.origin || req.header("X-Audit-Request") !== "1")
			)
				throw new AppError(403, "Same-origin request required");
			res.locals.actor = actor;
			next();
		} catch (e) {
			next(e);
		}
	});
	app.get("/api/meta", (_req, res) =>
		res.json({
			scope: { from: "2026-08-01", through: "2026-09-10", prefixes: ["6a", "ks"] },
			mode: config.mode,
			refreshEnabled: config.refreshEnabled,
			actor: res.locals.actor,
		}),
	);
	app.get("/api/jobs", (_req, res) => {
		const jobs = db
			.prepare("SELECT * FROM jobs ORDER BY started_at DESC LIMIT 20")
			.all()
			.map((j) => ({ ...j, report: JSON.parse(String(j.report)) }));
		const success = db
			.prepare(
				"SELECT completed_at FROM jobs WHERE kind='refresh' AND state='completed' ORDER BY completed_at DESC LIMIT 1",
			)
			.get();
		res.json({ jobs, last_successful_refresh: success?.completed_at ?? null });
	});
	app.get("/api/tables/:view", (req, res, next) => {
		try {
			const view = req.params.view as View;
			if (!Object.hasOwn(columns, view)) throw new AppError(404, "View not found");
			const params = new URL(req.originalUrl, "http://localhost").searchParams;
			let raw;
			try {
				raw = JSON.parse(params.get("filters") ?? "[]");
			} catch {
				throw new AppError(400, "Invalid filters");
			}
			res.json(query(db, view, params, decode(FilterInput, raw)));
		} catch (e) {
			next(e);
		}
	});
	app.get("/api/notes/:id", (req, res, next) => {
		try {
			res.json(getNote(db, String(req.params.id)));
		} catch (e) {
			next(e);
		}
	});
	app.put("/api/notes/:id", express.json({ limit: "64kb" }), (req, res, next) => {
		try {
			const value = decode(NoteInput, req.body);
			res.json(saveNote(db, String(req.params.id), value.text, value.revision, res.locals.actor));
		} catch (e) {
			next(e);
		}
	});
	app.post("/api/refresh", (_req, res, next) => {
		try {
			if (!config.refreshEnabled)
				throw new AppError(503, "Configure PARCELLAB_API_KEY_HASHED to enable refresh");
			const id = startJob(db, "refresh");
			launch(id, "refresh");
			res.status(202).json({ id });
		} catch (e) {
			next(e);
		}
	});
	app.post("/api/import/:kind", async (req, res, next) => {
		let id: string | undefined;
		let path: string | undefined;
		try {
			const kind = String(req.params.kind);
			if (!["audit", "responses"].includes(kind)) throw new AppError(400, "Invalid import type");
			const contentType = req.header("Content-Type")?.split(";")[0];
			if (
				kind === "audit"
					? contentType !== "text/csv"
					: contentType !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
			)
				throw new AppError(415, "Unsupported source format");
			id = startJob(db, kind);
			await mkdir(config.uploadDir, { recursive: true });
			path = join(config.uploadDir, randomUUID());
			let size = 0;
			const limit = new Transform({
				transform(chunk, _encoding, callback) {
					size += chunk.length;
					callback(
						size > 100 * 1024 * 1024 ? new AppError(413, "Upload exceeds 100 MB") : null,
						chunk,
					);
				},
			});
			await pipeline(req, limit, createWriteStream(path, { mode: 0o600 }));
			launch(id, kind, path);
			res.status(202).json({ id });
		} catch (e) {
			if (id) finishJob(db, id, "failed", {}, "Upload failed");
			if (path) await unlink(path).catch(() => {});
			next(e);
		}
	});
	if (config.staticDir) app.use(express.static(config.staticDir));
	app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
		const e = err instanceof AppError ? err : new AppError(500, "Request failed");
		res.status(e.status).json({ error: e.message, detail: e.detail });
	});
	return app;
}
export function runTask<A>(task: () => Promise<A>) {
	return Effect.runPromise(Effect.tryPromise({ try: task, catch: (error) => error }));
}
