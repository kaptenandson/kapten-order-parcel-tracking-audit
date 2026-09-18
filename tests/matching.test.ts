import { it, expect } from "vitest";
import { openDB } from "../src/server/db.js";
import { importAudit } from "../src/server/import.js";
import { matchResponses, orderResolver } from "../src/server/matching.js";
import { normalizeOrder, suffix, fullOrderPattern } from "../src/shared/contracts.js";
import { auditRow, csv } from "./fixtures.js";

it("cleans punctuation, identifies full orders and does not interpret tracking codes as order suffixes", () => {
	expect(normalizeOrder(" #KSAT-1002- 6689221! ")).toBe("ksat-1002-6689221");
	expect(normalizeOrder("KSNL10046689221")).toBe("ksnl-1004-6689221");
	for (const n of ["123456", "123456789"])
		expect(fullOrderPattern.test(`ksfr-1005-${n}`)).toBe(true);
	for (const n of ["12345", "1234567890"])
		expect(fullOrderPattern.test(`ksfr-1005-${n}`)).toBe(false);
	expect(suffix("1048317000105440242730")).toBe("");
	expect(suffix("customertext6689221")).toBe("");
});

it("resolves the user examples, rejects ambiguous or contradictory matches and exposes the canonical matcher", () => {
	const db = openDB(":memory:");
	try {
		importAudit(
			db,
			csv([
				auditRow("1", "ksat-1002-6689221"),
				auditRow("2", "ksat-1002-6607733"),
				auditRow("3", "ksde-1001-6607733"),
			]),
		);
		const resolve = orderResolver(db);
		expect(resolve(normalizeOrder("#ksat-1002-6689221")).status).toBe("matched_exact");
		expect(resolve("1002-6607733").status).toBe("matched_short_order");
		expect(resolve("6607733").status).toBe("ambiguous");
		expect(resolve("ksfr-1005-6607733").status).toBe("unmatched");
		db.prepare("INSERT INTO responses(id,source_key,order_number) VALUES(?,?,?)").run(
			"legacy",
			"legacy",
			"1002-6607733",
		);
		db.prepare("INSERT INTO notes VALUES(?,?,?,?,?)").run(
			"legacy",
			"Keep",
			1,
			"test",
			"2026-09-18",
		);
		matchResponses(db);
		expect(
			db.prepare("SELECT normalized_matcher FROM requests LIMIT 1").get()!.normalized_matcher,
		).toBe("ksat-1002-6607733");
		expect(db.prepare("SELECT text FROM notes WHERE entity='legacy'").get()!.text).toBe("Keep");
	} finally {
		db.close();
	}
});
