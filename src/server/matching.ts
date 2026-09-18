import type { DB } from "./db.js";
import { normalizeOrder, suffix, fullOrderPattern } from "../shared/contracts.js";

export function orderResolver(db: DB) {
	const exact = db.prepare("SELECT id FROM orders WHERE normalized=?");
	const bySuffix = db.prepare("SELECT id,normalized FROM orders WHERE suffix=?");
	return (normalized: string) => {
		let matches = exact.all(normalized);
		let method = "matched_exact";
		// A full but unknown order is not replaced by another country's order.
		if (!matches.length && !fullOrderPattern.test(normalized) && suffix(normalized)) {
			matches = bySuffix.all(suffix(normalized));
			if (/^\d{4}-/.test(normalized))
				matches = matches.filter((r) => String(r.normalized).endsWith("-" + normalized));
			method = "matched_short_order";
		}
		return {
			orderId: matches.length === 1 ? String(matches[0].id) : null,
			status: matches.length === 1 ? method : matches.length ? "ambiguous" : "unmatched",
		};
	};
}

export function matchResponses(db: DB) {
	const resolve = orderResolver(db);
	const update = db.prepare(
		"UPDATE responses SET normalized=?,suffix=?,order_id=?,match_status=? WHERE id=?",
	);
	for (const r of db.prepare("SELECT id,order_number FROM responses").all()) {
		const normalized = normalizeOrder(r.order_number);
		const match = resolve(normalized);
		update.run(normalized, suffix(normalized), match.orderId, match.status, r.id);
	}
}
