// mutation-lane: exclude
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getManagedToolsDir } from "../../clients/installer/index.js";
import { McpHarness } from "./harness.js";

// The TypeScript analyzer is present when typescript-language-server is on PATH
// or in the managed pi-lens tools tree. Without it, the primary verdict for
// app.ts must be an honest "unavailable", never a fabricated clean=1.
const typescriptServerPresent = [
	...(process.env.PATH ?? "").split(path.delimiter),
	path.join(getManagedToolsDir(), "node_modules", ".bin"),
].some(
	(dir) => dir !== "" && fs.existsSync(path.join(dir, "typescript-language-server")),
);

describe(
	"MCP re-registers an evicted session root (#2052)",
	{ retry: 2 },
	() => {
		let harness: McpHarness;
		let roots: string[];

		beforeAll(() => {
			roots = Array.from({ length: 129 }, (_, index) => {
				const root = fs.mkdtempSync(
					path.join(os.tmpdir(), `pi-lens-mcp-eviction-${index}-`),
				);
				fs.writeFileSync(path.join(root, "app.ts"), "export const app = 1;\n");
				return root;
			});
			harness = new McpHarness({ cwd: roots[0] });
		}, 30_000);

		afterAll(() => {
			harness.dispose();
			for (const root of roots)
				fs.rmSync(root, { recursive: true, force: true });
		}, 30_000);

		it("re-initializes the first root after the registry evicts it", async () => {
			let id = 1;
			await harness.request(id++, "initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "root-eviction-smoke", version: "0" },
			});
			harness.notify("notifications/initialized");

			for (const root of roots) {
				const response = await harness.request(id++, "tools/call", {
					name: "pilens_lsp_diagnostics",
					arguments: { cwd: root },
				});
				expect(response.error).toBeUndefined();
			}

			const recovered = await harness.request(id, "tools/call", {
				name: "pilens_lsp_diagnostics",
				arguments: {
					cwd: roots[0],
					paths: [path.join(roots[0]!, "app.ts")],
					serverScope: "primary",
					waitMs: 1,
				},
			});
			const text = String(
				(recovered.result as { content: { text: string }[] }).content[0]?.text,
			);
			expect(text).not.toContain("outside_project_root");
			if (typescriptServerPresent) {
				expect(text).toContain("clean=1");
			} else {
				expect(text).toContain("unavailable");
				expect(text).not.toContain("clean=1");
			}
		}, 180_000);
	},
);
