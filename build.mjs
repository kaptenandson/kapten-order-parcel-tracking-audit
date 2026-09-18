import { build } from "rolldown";
import { mkdir, copyFile, rm } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist/client", { recursive: true });
await build({
	input: "src/client/main.tsx",
	platform: "browser",
	transform: { define: { "process.env.NODE_ENV": JSON.stringify("production") } },
	output: { dir: "dist/client", entryFileNames: "app.js" },
});
await build({
	input: ["src/server/main.ts", "src/server/worker.ts"],
	platform: "node",
	external: [/^[^./]/],
	output: { dir: "dist/server", format: "esm" },
});
await copyFile("src/client/index.html", "dist/client/index.html");
await copyFile("src/client/style.css", "dist/client/style.css");
