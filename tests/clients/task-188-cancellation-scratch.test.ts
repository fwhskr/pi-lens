import { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LSPProcess } from "../../clients/lsp/launch.js";
import { removeTempDirSync } from "./test-utils.js";

const { launchLSP, failRemoval } = vi.hoisted(() => ({
	launchLSP: vi.fn(),
	failRemoval: { value: false },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rm: async (...args: Parameters<typeof actual.rm>) => {
			if (failRemoval.value) throw new Error("synthetic cleanup denial");
			return actual.rm(...args);
		},
	};
});
vi.mock("../../clients/lsp/launch.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/launch.js")>()),
	launchLSP,
}));
vi.mock("../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/installer/index.js")
	>()),
	getToolEnvironment: async () => ({ TASK_188_TOOL_ENV: "preserved" }),
}));

import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import { TypeScriptServer } from "../../clients/lsp/server.js";

// TASK-188: emulate the external wrapper's temporaryFile({name: "tscancellation"})
// allocation, not a real process or a patch to installed node_modules. The wrapper
// resolves os.tmpdir() at startup and leaves these 32-hex children behind on exit.
describe("TypeScript cancellation scratch ownership", () => {
	let root: string;
	let home: string;
	const launches: Array<{
		temp: string;
		cancellation: string;
		child: ChildProcess;
		env: NodeJS.ProcessEnv;
	}> = [];

	beforeEach(() => {
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		failRemoval.value = false;
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-task-188-"));
		home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-task-188-home-"));
		vi.stubEnv("HOME", home);
		vi.stubEnv("PI_CODING_AGENT_DIR", "");
		const bin = path.join(root, "node_modules", ".bin");
		const typescript = path.join(root, "node_modules", "typescript");
		fs.mkdirSync(bin, { recursive: true });
		fs.mkdirSync(path.join(typescript, "lib"), { recursive: true });
		fs.writeFileSync(path.join(bin, "typescript-language-server"), "");
		fs.writeFileSync(
			path.join(typescript, "package.json"),
			'{"version":"6.0.3"}',
		);
		fs.writeFileSync(path.join(typescript, "lib", "tsserver.js"), "");
		launchLSP.mockReset();
		launchLSP.mockImplementation(async (command, args, options) => {
			const env = options.env as NodeJS.ProcessEnv;
			const temp = env.TMPDIR ?? os.tmpdir();
			const cancellation = path.join(temp, "0123456789abcdef0123456789abcdef");
			fs.mkdirSync(cancellation, { recursive: true });
			fs.writeFileSync(path.join(cancellation, "tscancellation1"), "");
			const child = new ChildProcess(); // Unspawned: no invented OS pid is signalled.
			launches.push({ temp, cancellation, child, env });
			return {
				process: child,
				stdin: new PassThrough(),
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				pid: 0,
				command,
				args,
			} satisfies LSPProcess;
		});
	});

	afterEach(async () => {
		await flushLatencyLog();
		failRemoval.value = false;
		vi.unstubAllEnvs();
		for (const launch of launches.splice(0)) {
			launch.child.emit("close", 0, null);
			// Pre-fix red runs can leave children in the isolated ambient temp root.
			removeTempDirSync(launch.cancellation);
			if (launch.temp !== os.tmpdir()) removeTempDirSync(launch.temp);
		}
		removeTempDirSync(root);
		removeTempDirSync(home);
	});

	it("removes its private cancellation namespace after normal shutdown", async () => {
		const result = await TypeScriptServer.spawn(root, { allowInstall: false });
		const launch = launches[0];
		expect(result?.launchVariant).toBe("classic");
		expect(fs.existsSync(launch.cancellation)).toBe(true);
		launch.child.emit("close", 0, null);
		await expect
			.poll(() => fs.existsSync(launch.temp), { timeout: 1000 })
			.toBe(false);
		expect(fs.existsSync(launch.cancellation)).toBe(false);
		await flushLatencyLog();
		const records = fs
			.readFileSync(getLatencyLogPath(), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records).toContainEqual(
			expect.objectContaining({
				phase: "lsp_typescript_scratch_cleanup",
				metadata: expect.objectContaining({
					tempDir: launch.temp,
					reason: "close",
					status: "removed",
				}),
			}),
		);
		expect(path.dirname(launch.temp)).toBe(
			path.join(home, ".pi", "agent", "var", "tmp"),
		);
		expect(launch.env.TMP).toBe(launch.temp);
		expect(launch.env.TEMP).toBe(launch.temp);
		expect(launch.env.TASK_188_TOOL_ENV).toBe("preserved");
		expect(launch.env.TSSERVER_PATH).toBe(
			path.join(root, "node_modules", "typescript", "lib", "tsserver.js"),
		);
	});

	it("removes allocated scratch when the external launch rejects", async () => {
		const allocate = launchLSP.getMockImplementation()!;
		const failure = new Error("synthetic startup failure");
		launchLSP.mockImplementation(async (...args) => {
			await allocate(...args);
			throw failure;
		});
		await expect(
			TypeScriptServer.spawn(root, { allowInstall: false }),
		).rejects.toBe(failure);
		expect(fs.existsSync(launches[0].cancellation)).toBe(false);
		expect(fs.existsSync(launches[0].temp)).toBe(false);
	});

	it("records a cleanup failure without rejecting shutdown", async () => {
		await TypeScriptServer.spawn(root, { allowInstall: false });
		const launch = launches[0];
		failRemoval.value = true;
		launch.child.emit("close", 0, null);
		// Observe the real sink, not a mocked logging call or only not.toThrow.
		await expect
			.poll(
				async () => {
					await flushLatencyLog();
					return fs
						.readFileSync(getLatencyLogPath(), "utf8")
						.includes("synthetic cleanup denial");
				},
				{ timeout: 1000 },
			)
			.toBe(true);
		const records = fs
			.readFileSync(getLatencyLogPath(), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records).toContainEqual(
			expect.objectContaining({
				phase: "lsp_typescript_scratch_cleanup",
				metadata: expect.objectContaining({
					tempDir: launch.temp,
					reason: "close",
					status: "failed",
					error: "synthetic cleanup denial",
				}),
			}),
		);
		expect(fs.existsSync(launch.cancellation)).toBe(true);
	});

	it("disposes a server that already closed before launch returned", async () => {
		const allocate = launchLSP.getMockImplementation()!;
		launchLSP.mockImplementation(async (...args) => {
			const result = await allocate(...args);
			result.process.exitCode = 0;
			result.process.emit("close", 0, null);
			return result;
		});
		await TypeScriptServer.spawn(root, { allowInstall: false });
		expect(fs.existsSync(launches[0].temp)).toBe(false);
	});

	it("does not remove another live server or ambient cancellation directory", async () => {
		const foreign = path.join(root, "fedcba9876543210fedcba9876543210");
		fs.mkdirSync(foreign);
		await Promise.all([
			TypeScriptServer.spawn(root, { allowInstall: false }),
			TypeScriptServer.spawn(root, { allowInstall: false }),
		]);
		const [first, second] = launches;
		expect(first.temp).not.toBe(second.temp);
		first.child.emit("close", 0, null);
		await expect
			.poll(() => fs.existsSync(first.temp), { timeout: 1000 })
			.toBe(false);
		expect(fs.existsSync(second.cancellation)).toBe(true);
		expect(fs.existsSync(foreign)).toBe(true);
		second.child.emit("close", 0, null);
		await expect
			.poll(() => fs.existsSync(second.temp), { timeout: 1000 })
			.toBe(false);
		expect(fs.existsSync(foreign)).toBe(true);
	});
});
