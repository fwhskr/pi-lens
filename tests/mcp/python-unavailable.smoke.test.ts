// mutation-lane: exclude
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpHarness } from "./harness.js";

describe("lsp diagnostics with no Python analyzer (TASK-130)", () => {
	let harness: McpHarness;
	let root: string;

	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-py-absent-"));
		// Synthetic fixture: one unused import, which only a Python analyzer can flag.
		fs.writeFileSync(
			path.join(root, "unused.py"),
			"import os\n\nprint('hello')\n",
		);
		harness = new McpHarness({ cwd: root });
	}, 30_000);

	afterAll(() => {
		harness.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}, 30_000);

	it("reports unavailable, never a false clean, when no Python analyzer is installed", async () => {
		let id = 1;
		await harness.request(id++, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "py-absent-smoke", version: "0" },
		});
		harness.notify("notifications/initialized");

		const response = await harness.request(id, "tools/call", {
			name: "pilens_lsp_diagnostics",
			arguments: {
				cwd: root,
				paths: [path.join(root, "unused.py")],
				serverScope: "primary",
			},
		});
		expect(response.error).toBeUndefined();
		const text = String(
			(response.result as { content: { text: string }[] }).content[0]?.text,
		);
		expect(text).not.toContain("clean=1");
		expect(text).toContain("unavailable=1");
	}, 120_000);
});
