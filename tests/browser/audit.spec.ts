import { test, expect } from "@playwright/test";
import { auditRow, csv } from "../fixtures.js";
test("three tables, filters, note persistence and stale-edit conflict", async ({
	page,
	request,
}) => {
	const imported = await request.post("/api/import/audit", {
		headers: {
			Origin: "http://localhost:3199",
			"X-Audit-Request": "1",
			"Content-Type": "text/csv",
		},
		data: csv([auditRow()]),
	});
	expect(imported.status()).toBe(202);
	const { id } = await imported.json();
	await expect
		.poll(async () => {
			const r = await request.get("/api/jobs");
			return (await r.json()).jobs.find((j: any) => j.id === id).state;
		})
		.toBe("completed");
	await page.goto("/");
	await expect(page.getByLabel("Import audit CSV")).toHaveCount(0);
	await expect(page.getByLabel("Import responses workbook")).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Delivery audit." })).toBeVisible();
	await expect(page.getByRole("cell", { name: "ksde-1001-1234567", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Parcels ↗" }).click();
	await expect(page.getByRole("cell", { name: "000123", exact: true })).toBeVisible();
	await page.getByLabel("Search audit").fill("000123");
	await expect(page.locator("tbody tr")).toHaveCount(1);
	await page.locator(".note-button").first().click();
	await page.getByLabel("Note text").fill("Contacted customer <script>no execution</script>");
	await page.getByRole("button", { name: "Save note", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.reload();
	await page.locator(".note-button").first().click();
	await expect(page.getByLabel("Note text")).toHaveValue(
		"Contacted customer <script>no execution</script>",
	);
	const rows = await (await request.get("/api/tables/parcels?q=000123")).json();
	const entity = rows.rows[0].note_id;
	const current = await (await request.get("/api/notes/" + encodeURIComponent(entity))).json();
	await request.put("/api/notes/" + encodeURIComponent(entity), {
		headers: { Origin: "http://localhost:3199", "X-Audit-Request": "1" },
		data: { text: "Second employee edit", revision: current.revision },
	});
	await page.getByLabel("Note text").fill("My unsaved draft");
	await page.getByRole("button", { name: "Save note", exact: true }).click();
	await expect(page.getByText("Another employee saved a change.")).toBeVisible();
	await expect(page.getByLabel("Note text")).toHaveValue("My unsaved draft");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await page.getByRole("button", { name: "Customer Requests", exact: true }).click();
	await expect(
		page.getByRole("columnheader", { name: "Normalized matcher", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("columnheader", { name: "Latest parcel update time (UTC)" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Orders", exact: true }).click();
	await page.getByRole("button", { name: "＋ Add filter" }).click();
	await page.getByLabel("Filter column 1").selectOption("count_RE");
	await page.getByLabel("Filter value 1").fill("2");
	await expect(page.locator("tbody tr")).toHaveCount(1);
});
