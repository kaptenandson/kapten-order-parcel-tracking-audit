import { arrayMap } from "../src/server/import.js";
export function auditRow(ab = "1", project = "ksde-1001-1234567", tracks = ["000123", "000456"]) {
	const r: Record<string, string> = {
		"AB id": ab,
		projectId: project,
		ab_created_at: "2026-08-20T12:00:00Z",
		count_RE: "2",
		count_active_RE: "1",
		count_GU: "0",
		count_active_GU: "0",
		count_WG: "1",
		count_active_WG: "1",
		list_trackings: JSON.stringify(tracks),
	};
	for (const [key, col] of Object.entries(arrayMap))
		r[col] = JSON.stringify(
			tracks.map((_, i) =>
				key === "status_code" || key === "status"
					? i === 0
						? "InTransit"
						: "Delivered"
					: key === "is_delivered"
						? i !== 0
						: key === "last_updated"
							? "2026-09-17T12:00:00Z"
							: key === "status_timestamp"
								? "2026-09-16T10:00:00Z"
								: key === "latest_movement_date"
									? "2026-09-16"
									: key === "lookup_status"
										? "matched"
										: key === "status_step"
											? "3"
											: null,
			),
		);
	return r;
}
export function csv(rows: Record<string, string>[]) {
	const fields = Object.keys(rows[0]);
	const cell = (s: string) => '"' + s.replaceAll('"', '""') + '"';
	return Buffer.from(
		"\ufeff" +
			fields.map(cell).join(";") +
			"\n" +
			rows.map((r) => fields.map((k) => cell(r[k] ?? "")).join(";")).join("\n"),
	);
}
export const raw = (tn: string, code = "Delivered", updated = "2026-09-18T10:00:00Z") => ({
	tn,
	co: { n: "postnl" },
	lst: { dat: updated, sta: { code, status: code, timestamp: "2026-09-18T09:00:00Z", step: 4 } },
});
