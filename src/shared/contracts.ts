import { Schema } from "effect";
export type View = "orders" | "parcels" | "requests";
export type Column = { key: string; label: string; type: "text" | "number" | "date" | "boolean" };
const col = (key: string, type: Column["type"] = "text", label = key): Column => ({
	key,
	type,
	label,
});
export const orderColumns = [
	col("ab_id", "text", "AB id"),
	col("projectId"),
	col("ab_created_at", "date"),
	...["RE", "GU", "WG"].flatMap((x) => [
		col(`count_${x}`, "number"),
		col(`count_active_${x}`, "number"),
	]),
	...[
		"tracking_count",
		"matched_tracking_count",
		"unresolved_tracking_count",
		"delivered_tracking_count",
		"exception_tracking_count",
	].map((x) => col(x, "number")),
	col("latest_movement_date", "date"),
	col("latest_parcellab_update_at", "date"),
	col("tracking_coverage"),
	col("delivery_rollup"),
];
export const parcelColumns = [
	col("ab_id", "text", "AB id"),
	col("projectId"),
	col("tracking_sequence", "number"),
	col("tracking_no"),
	col("courier"),
	col("status_code"),
	col("status"),
	col("status_timestamp", "date"),
	col("latest_movement_date", "date"),
	col("last_updated", "date"),
	col("status_step", "number"),
	col("lifecycle"),
	col("is_delivered", "boolean"),
	col("lookup_status"),
	col("recheck_checked_at", "date"),
	col("recheck_result"),
	col("recheck_error"),
	col("refresh_checked_at", "date"),
	col("refresh_result"),
	col("refresh_error"),
];
export const requestColumns = [
	col("order_number", "text", "Bestellnummer"),
	col("normalized_matcher", "text", "Normalized matcher"),
	col("match_status", "text", "Order match"),
	col("request_type", "text", "Ich möchte eine"),
	col("email", "text", "Email"),
	col("tracking_no", "text", "Tracking number"),
	col("latest_status", "text", "Latest parcel status"),
	col("last_updated", "date", "Latest parcel update time (UTC)"),
];
export const columns: Record<View, Column[]> = {
	orders: [...orderColumns, col("notes", "text", "Notes")],
	parcels: [...parcelColumns, col("notes", "text", "Notes")],
	requests: [...requestColumns, col("notes", "text", "Notes")],
};
export const NoteInput = Schema.Struct({
	text: Schema.String.pipe(Schema.maxLength(10000)),
	revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});
export const FilterInput = Schema.Array(
	Schema.Struct({
		column: Schema.String,
		op: Schema.Literal("contains", "eq", "gte", "lte", "empty", "notempty", "in"),
		value: Schema.optional(Schema.String.pipe(Schema.maxLength(1000))),
	}),
).pipe(Schema.maxItems(30));
export type Filter = Schema.Schema.Type<typeof FilterInput>[number];
export type Row = Record<string, string | number | null>;
export type Page = {
	rows: Row[];
	total: number;
	page: number;
	pageSize: number;
	columns: Column[];
};
export type Note = {
	text: string;
	revision: number;
	updated_at: string | null;
	editor: string | null;
};
export const normalizeOrder = (v: unknown) =>
	String(v ?? "")
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "")
		.replace(/^(ks[a-z]{2})-?(\d{4})-?(\d{6,9})$/, "$1-$2-$3");
export const fullOrderPattern = /^ks[a-z]{2}-\d{4}-\d{6,9}$/i;
export const suffix = (v: string) =>
	fullOrderPattern.test(v) || /^(?:\d{4}-)?\d{6,9}$/.test(v)
		? (v.match(/(?:^|-)(\d{6,9})$/)?.[1] ?? "")
		: "";
