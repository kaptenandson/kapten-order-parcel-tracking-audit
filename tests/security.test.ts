import { it, expect } from "vitest";
import { createServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import request from "supertest";
import { openDB } from "../src/server/db.js";
import { createApp } from "../src/server/app.js";
it("validates actual signatures, issuer, audience and expiry using a JWKS endpoint", async () => {
	const { privateKey, publicKey } = await generateKeyPair("RS256");
	const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" };
	const server = createServer((_req, res) => {
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ keys: [jwk] }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as { port: number };
	const issuer = `http://127.0.0.1:${address.port}`;
	const db = openDB(":memory:");
	try {
		const app = createApp(
			db,
			{
				mode: "access",
				production: true,
				origin: "https://audit.example.test",
				issuer,
				audience: "audit",
				uploadDir: "/tmp",
				refreshEnabled: false,
			},
			() => {},
		);
		const token = (aud = "audit", iss = issuer, exp: number | string = "1h", key = privateKey) =>
			new SignJWT({ email: "employee@example.test" })
				.setProtectedHeader({ alg: "RS256", kid: "test" })
				.setSubject("employee")
				.setIssuer(iss)
				.setAudience(aud)
				.setExpirationTime(exp)
				.sign(key);
		const access = async (t: string) =>
			request(app).get("/api/meta").set("Cf-Access-Jwt-Assertion", t);
		expect((await access(await token())).status).toBe(200);
		expect((await access(await token("wrong"))).status).toBe(401);
		expect((await access(await token("audit", "https://wrong.test"))).status).toBe(401);
		expect((await access(await token("audit", issuer, 1))).status).toBe(401);
		const wrong = await generateKeyPair("RS256");
		expect((await access(await token("audit", issuer, "1h", wrong.privateKey))).status).toBe(401);
	} finally {
		db.close();
		await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
	}
});
