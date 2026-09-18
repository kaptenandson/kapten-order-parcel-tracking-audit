import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	columns,
	type View,
	type Filter,
	type Row,
	type Page,
	type Note,
} from "../shared/contracts.js";
class ApiError extends Error {
	constructor(
		message: string,
		public status: number,
		public detail?: Note,
	) {
		super(message);
	}
}
async function api(path: string, options: RequestInit = {}) {
	const r = await fetch("/api" + path, {
		...options,
		headers: { "X-Audit-Request": "1", ...options.headers },
	});
	const body = await r.json();
	if (!r.ok) throw new ApiError(body.error ?? "Request failed", r.status, body.detail);
	return body;
}
const titles: Record<View, string> = {
	orders: "Orders",
	parcels: "Parcels",
	requests: "Customer Requests",
};
function App() {
	const [params, setParams] = useState(() => new URLSearchParams(location.search));
	const view = (
		["orders", "parcels", "requests"].includes(params.get("view") ?? "")
			? params.get("view")
			: "orders"
	) as View;
	const [data, setData] = useState<Page>();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [tick, setTick] = useState(0);
	const [search, setSearch] = useState(params.get("q") ?? "");
	const [meta, setMeta] = useState<any>();
	const [jobs, setJobs] = useState<any>({ jobs: [] });
	const [editing, setEditing] = useState<Row | null>(null);
	const [note, setNote] = useState<Note | null>(null);
	const [draft, setDraft] = useState("");
	const [conflict, setConflict] = useState<Note | null>(null);
	const [saving, setSaving] = useState(false);
	const [noteError, setNoteError] = useState("");
	const filters: Filter[] = (() => {
		try {
			return JSON.parse(params.get("filters") ?? "[]");
		} catch {
			return [];
		}
	})();
	function change(values: Record<string, string | undefined>) {
		setParams((previous) => {
			const next = new URLSearchParams(previous);
			for (const [k, v] of Object.entries(values)) {
				if (v) next.set(k, v);
				else next.delete(k);
			}
			history.pushState({}, "", `?${next}`);
			return next;
		});
	}
	useEffect(() => {
		const pop = () => {
			const p = new URLSearchParams(location.search);
			setParams(p);
			setSearch(p.get("q") ?? "");
		};
		addEventListener("popstate", pop);
		return () => removeEventListener("popstate", pop);
	}, []);
	useEffect(() => {
		const timer = setTimeout(() => {
			if (search !== (params.get("q") ?? "")) change({ q: search, page: "1" });
		}, 300);
		return () => clearTimeout(timer);
	}, [search, params]);
	useEffect(() => {
		const controller = new AbortController();
		setBusy(true);
		setError("");
		api(`/tables/${view}?${params}`, { signal: controller.signal })
			.then(setData)
			.catch((e) => {
				if (e.name !== "AbortError") setError(e.message);
			})
			.finally(() => {
				if (!controller.signal.aborted) setBusy(false);
			});
		return () => controller.abort();
	}, [params, tick, view]);
	useEffect(() => {
		api("/meta")
			.then(setMeta)
			.catch((e) => setError(e.message));
		let previous = "";
		const poll = () =>
			api("/jobs")
				.then((j) => {
					const signature = JSON.stringify(j.jobs.map((x: any) => [x.id, x.state]));
					if (previous && signature !== previous) setTick((t) => t + 1);
					previous = signature;
					setJobs(j);
				})
				.catch((e) => setError(e.message));
		poll();
		const timer = setInterval(poll, 3000);
		return () => clearInterval(timer);
	}, []);
	const running = jobs.jobs.some((j: any) => j.state === "running");
	function navigate(next: View, orderId?: string) {
		setSearch("");
		change({
			view: next,
			q: undefined,
			filters: undefined,
			sort: undefined,
			direction: undefined,
			page: "1",
			orderId,
		});
	}
	function filter(index: number, values: Partial<Filter>) {
		const next = filters.map((f, i) => (i === index ? { ...f, ...values } : f));
		change({ filters: JSON.stringify(next), page: "1" });
	}
	async function edit(row: Row) {
		setNote(null);
		setEditing(row);
		setConflict(null);
		setNoteError("");
		try {
			const n = await api("/notes/" + encodeURIComponent(String(row.note_id)));
			setNote(n);
			setDraft(n.text);
		} catch (e) {
			setNoteError((e as Error).message);
		}
	}
	async function save() {
		if (!editing || !note) return;
		setSaving(true);
		setNoteError("");
		try {
			await api("/notes/" + encodeURIComponent(String(editing.note_id)), {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text: draft, revision: note.revision }),
			});
			setEditing(null);
			setTick((t) => t + 1);
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) setConflict(e.detail!);
			else setNoteError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}
	return (
		<>
			<header>
				<div className="brand">
					KAPTEN &amp; SON <span>OPERATIONS</span>
				</div>
				<div className="identity">{meta?.mode === "local" ? "Local workspace" : meta?.actor}</div>
			</header>
			<main>
				<section className="heading">
					<div>
						<p className="eyebrow">CUSTOMER CARE / DELIVERY</p>
						<h1>
							Delivery audit<span className="dot">.</span>
						</h1>
						<p className="subtitle">
							One place for orders, parcel progress and the work behind them.
						</p>
					</div>
					<div className="freshness">
						<span className="live-dot" />
						Last successful tracking refresh
						<br />
						<strong>
							{jobs.last_successful_refresh
								? new Date(jobs.last_successful_refresh).toLocaleString("en-GB", {
										timeZone: "UTC",
									}) + " UTC"
								: "No refresh completed yet"}
						</strong>
					</div>
				</section>
				<section className="workspace">
					<div className="tabs">
						{Object.entries(titles).map(([key, title]) => (
							<button
								key={key}
								className={key === view ? "active" : ""}
								onClick={() => navigate(key as View)}
							>
								{title}
							</button>
						))}
						<span className="scope">01 Aug – 10 Sep 2026 · 6a / ks</span>
					</div>
					<div className="toolbar">
						<label className="search">
							<span>⌕</span>
							<input
								aria-label="Search audit"
								placeholder="Search order, tracking, email or notes…"
								value={search}
								onChange={(e) => setSearch(e.target.value)}
							/>
						</label>
						<button
							onClick={() =>
								change({
									filters: JSON.stringify([
										...filters,
										{ column: columns[view][0].key, op: "eq", value: "" },
									]),
									page: "1",
								})
							}
						>
							＋ Add filter
						</button>
						<div className="spacer" />
						<button
							className="primary"
							disabled={running || !meta?.refreshEnabled}
							title={!meta?.refreshEnabled ? "Configure parcelLab credentials on the server" : ""}
							onClick={async () => {
								try {
									await api("/refresh", { method: "POST" });
									setJobs(await api("/jobs"));
								} catch (e) {
									setError((e as Error).message);
								}
							}}
						>
							{running ? "Update in progress…" : "↻ Refresh tracking"}
						</button>
					</div>
					{params.get("orderId") && (
						<div className="filter-row">
							Linked order{" "}
							<button onClick={() => change({ orderId: undefined, page: "1" })}>
								Clear link ×
							</button>
						</div>
					)}
					{filters.map((f, i) => (
						<div className="filter-row" key={i}>
							<select
								aria-label={`Filter column ${i + 1}`}
								value={f.column}
								onChange={(e) => filter(i, { column: e.target.value, op: "eq", value: "" })}
							>
								{columns[view].map((c) => (
									<option key={c.key} value={c.key}>
										{c.label}
									</option>
								))}
							</select>
							<select
								aria-label={`Filter operator ${i + 1}`}
								value={f.op}
								onChange={(e) => filter(i, { op: e.target.value as Filter["op"] })}
							>
								{[
									["eq", "Equals"],
									["contains", "Contains"],
									["gte", "At least / after"],
									["lte", "At most / before"],
									["in", "One of (separate with |)"],
									["empty", "Empty / unknown"],
									["notempty", "Not empty"],
								]
									.filter(
										([op]) =>
											op !== "contains" ||
											columns[view].find((c) => c.key === f.column)?.type === "text",
									)
									.filter(
										([op]) =>
											!["gte", "lte"].includes(op) ||
											["number", "date"].includes(
												columns[view].find((c) => c.key === f.column)?.type ?? "",
											),
									)
									.map(([op, label]) => (
										<option key={op} value={op}>
											{label}
										</option>
									))}
							</select>
							{!["empty", "notempty"].includes(f.op) && (
								<input
									aria-label={`Filter value ${i + 1}`}
									value={f.value ?? ""}
									placeholder="Value (dates: YYYY-MM-DD)"
									onChange={(e) => filter(i, { value: e.target.value })}
								/>
							)}
							<button
								aria-label={`Remove filter ${i + 1}`}
								onClick={() =>
									change({ filters: JSON.stringify(filters.filter((_, j) => j !== i)), page: "1" })
								}
							>
								×
							</button>
						</div>
					))}
					{error && (
						<div role="alert" className="error">
							{error} <button onClick={() => setTick((t) => t + 1)}>Retry</button>
						</div>
					)}
					<div className="table-meta">
						<strong>{titles[view]}</strong>
						<span>
							{data?.total.toLocaleString() ?? "—"} matching rows {busy ? "· Loading…" : ""}
						</span>
						<span className="hint">
							Source data is read-only · Notes are shared · Times are UTC
						</span>
					</div>
					<div className="table-wrap" aria-busy={busy}>
						<table>
							<thead>
								<tr>
									{columns[view].map((c) => (
										<th key={c.key}>
											<button
												onClick={() =>
													change({
														sort: c.key,
														direction:
															params.get("sort") === c.key && params.get("direction") !== "desc"
																? "desc"
																: "asc",
														page: "1",
													})
												}
											>
												{c.label}
												{params.get("sort") === c.key
													? params.get("direction") === "desc"
														? " ↓"
														: " ↑"
													: ""}
											</button>
										</th>
									))}
									<th>Related</th>
								</tr>
							</thead>
							<tbody>
								{!busy && data?.rows.length === 0 ? (
									<tr>
										<td colSpan={columns[view].length + 1}>
											<div className="empty">
												<h2>No matching records</h2>
												<p>Import an audit to get started, or adjust your filters.</p>
											</div>
										</td>
									</tr>
								) : (
									data?.rows.map((row) => (
										<tr key={String(row.id)}>
											{columns[view].map((c) => (
												<td key={c.key} className={c.key.includes("tracking") ? "mono" : ""}>
													{c.key === "notes" ? (
														<button className="note-button" onClick={() => edit(row)}>
															{row.notes ? String(row.notes).slice(0, 60) : "＋ Add note"}
														</button>
													) : c.type === "boolean" ? (
														row[c.key] === null ? (
															"Unknown"
														) : row[c.key] === 1 ? (
															"Yes"
														) : (
															"No"
														)
													) : c.type === "date" && row[c.key] ? (
														String(row[c.key])
															.replace("T", " ")
															.replace(/\.\d{3}Z$/, " UTC")
													) : ["status_code", "latest_status", "delivery_rollup"].includes(
															c.key,
													  ) ? (
														<span
															className={
																"badge " +
																(String(row[c.key]).toLowerCase().includes("delivered")
																	? "green"
																	: String(row[c.key]).toLowerCase().includes("exception")
																		? "red"
																		: "")
															}
														>
															{row[c.key] ?? "—"}
														</span>
													) : (
														(row[c.key] ?? "—")
													)}
												</td>
											))}
											<td>
												<div className="related">
													{view !== "orders" && row.order_id && (
														<button onClick={() => navigate("orders", String(row.order_id))}>
															Order ↗
														</button>
													)}
													{view === "orders" && (
														<>
															<button onClick={() => navigate("parcels", String(row.id))}>
																Parcels ↗
															</button>
															<button onClick={() => navigate("requests", String(row.id))}>
																Requests ↗
															</button>
														</>
													)}
												</div>
											</td>
										</tr>
									))
								)}
							</tbody>
						</table>
					</div>
					<footer>
						<span>
							Page {data?.page ?? 1} of{" "}
							{Math.max(1, Math.ceil((data?.total ?? 0) / (data?.pageSize ?? 50)))}
						</span>
						<div>
							<button
								disabled={busy || (data?.page ?? 1) <= 1}
								onClick={() => change({ page: String((data?.page ?? 1) - 1) })}
							>
								← Previous
							</button>
							<button
								disabled={busy || !data || data.page * data.pageSize >= data.total}
								onClick={() => change({ page: String((data?.page ?? 1) + 1) })}
							>
								Next →
							</button>
						</div>
					</footer>
				</section>
				<details className="runs">
					<summary>Import &amp; refresh activity {running ? "— running" : ""}</summary>
					{jobs.jobs.length === 0 ? (
						<p>No jobs yet. Import your existing files to begin.</p>
					) : (
						jobs.jobs.map((j: any) => (
							<div className="run" key={j.id}>
								<strong>
									{j.kind} · {j.state}
								</strong>
								<span>{j.completed_at ?? j.started_at}</span>
								{j.error && <p role="alert">{j.error}</p>}
								<dl>
									{Object.entries(j.report).map(([k, v]) => (
										<React.Fragment key={k}>
											<dt>{k.replaceAll("_", " ")}</dt>
											<dd>{String(v)}</dd>
										</React.Fragment>
									))}
								</dl>
							</div>
						))
					)}
				</details>
			</main>
			{editing && (
				<div className="overlay">
					<section role="dialog" aria-modal="true" aria-label="Edit note" className="modal">
						<p className="eyebrow">SHARED NOTES</p>
						<h2>Leave the next person informed.</h2>
						<p>{String(editing.projectId ?? editing.order_number ?? editing.ab_id)}</p>
						{note && (
							<>
								<textarea
									autoFocus
									aria-label="Note text"
									maxLength={10000}
									rows={7}
									value={draft}
									onChange={(e) => setDraft(e.target.value)}
								/>
								<small>
									{note.editor
										? `Last edited by ${note.editor} · ${note.updated_at}`
										: "No note yet"}{" "}
									· {draft.length}/10,000
								</small>
							</>
						)}
						{noteError && <p role="alert">{noteError}</p>}
						{conflict && (
							<div className="error">
								<strong>Another employee saved a change.</strong>
								<p>Your draft is still above. Latest saved note:</p>
								<pre>{conflict.text}</pre>
								<button
									onClick={() => {
										setNote(conflict);
										setConflict(null);
									}}
								>
									Use latest revision, keep my draft for review
								</button>
							</div>
						)}
						<div className="modal-actions">
							<button onClick={() => setEditing(null)} disabled={saving}>
								Cancel
							</button>
							<button className="primary" disabled={!note || saving || !!conflict} onClick={save}>
								{saving ? "Saving…" : "Save note"}
							</button>
						</div>
					</section>
				</div>
			)}
		</>
	);
}
createRoot(document.getElementById("root")!).render(<App />);
