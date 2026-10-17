import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const { ensureTool, getToolEnvironment, launchLSP } = vi.hoisted(() => ({
	ensureTool: vi.fn(),
	getToolEnvironment: vi.fn(async () => ({ PI_LENS_TEST_TOOLCHAIN: "1" })),
	launchLSP: vi.fn(),
}));

vi.mock("../../../clients/installer/index.js", () => ({
	ensureTool,
	getToolEnvironment,
	findManagedToolBinary: vi.fn(async () => undefined),
}));
vi.mock("../../../clients/lsp/launch.js", () => ({
	launchLSP,
	admitProjectSuppliedTsserver: (tsserverPath: string) => tsserverPath,
}));
vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency: vi.fn(),
}));

import { TypeScriptServer } from "../../../clients/lsp/server.js";
import type { LSPProcess } from "../../../clients/lsp/launch.js";

const dirs: string[] = [];
let fakeProcess: LSPProcess;

function ownedTempEnvironment(): NodeJS.ProcessEnv {
	const temp = launchLSP.mock.calls.at(-1)?.[2].env.TMPDIR;
	expect(temp).toEqual(expect.any(String));
	expect(temp).not.toBe(os.tmpdir());
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	expect(agentDir).toEqual(expect.any(String));
	expect(path.dirname(temp as string)).toBe(
		path.join(agentDir as string, "var", "tmp"),
	);
	expect(fs.existsSync(temp as string)).toBe(true);
	return { TMPDIR: temp as string, TMP: temp as string, TEMP: temp as string };
}

function addTypeScriptPackage(root: string, version: string): void {
	fs.mkdirSync(path.join(root, "node_modules", "typescript"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(root, "node_modules", "typescript", "package.json"),
		JSON.stringify({ name: "typescript", version }),
	);
}

function makeProject(version: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ts-native-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, ".pi", "agent"));
	dirs.push(root);
	addTypeScriptPackage(root, version);
	return root;
}

function addWorkspacePackage(workspaceRoot: string): {
	packageRoot: string;
	sourceFile: string;
} {
	const packageRoot = path.join(workspaceRoot, "packages", "app");
	const sourceFile = path.join(packageRoot, "src", "index.ts");
	fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
	fs.writeFileSync(path.join(packageRoot, "package.json"), '{"private":true}');
	fs.writeFileSync(sourceFile, "export const value = 1;\n");
	return { packageRoot, sourceFile };
}

function addNativeTsc(root: string): string {
	const binDir = path.join(root, "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	const command = path.join(
		binDir,
		process.platform === "win32" ? "tsc.cmd" : "tsc",
	);
	fs.writeFileSync(command, "");
	return command;
}

function addClassicWrapper(root: string): string {
	const binDir = path.join(root, "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	const lspPath = path.join(binDir, "typescript-language-server");
	fs.writeFileSync(lspPath, "");
	return lspPath;
}

function addClassicServer(root: string) {
	const lspPath = addClassicWrapper(root);
	const tsserverPath = path.join(
		root,
		"node_modules",
		"typescript",
		"lib",
		"tsserver.js",
	);
	fs.mkdirSync(path.dirname(tsserverPath), { recursive: true });
	fs.writeFileSync(tsserverPath, "");
	return { lspPath, tsserverPath };
}

describe("TypeScript native LSP selection", () => {
	beforeEach(() => {
		ensureTool.mockReset();
		ensureTool.mockResolvedValue(undefined);
		getToolEnvironment.mockClear();
		launchLSP.mockReset();
		fakeProcess = {
			process: new ChildProcess(),
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			pid: 0,
			command: "synthetic-lsp",
			args: [],
		};
		launchLSP.mockResolvedValue(fakeProcess);
	});

	afterEach(async () => {
		fakeProcess.process.emit("close", 0, null);
		const temp = launchLSP.mock.calls.at(-1)?.[2].env.TMPDIR;
		if (temp) {
			await expect
				.poll(() => fs.existsSync(temp), { timeout: 1000 })
				.toBe(false);
		}
		for (const dir of dirs.splice(0)) {
			removeTempDirSync(dir);
		}
		vi.unstubAllEnvs();
	});

	it("launches the project-local TypeScript 7 binary in native LSP mode", async () => {
		const root = makeProject("7.0.2");
		const command = addNativeTsc(root);

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchLSP).toHaveBeenCalledWith(command, ["--lsp", "--stdio"], {
			cwd: root,
			env: { PI_LENS_TEST_TOOLCHAIN: "1" },
		});
		expect(ensureTool).not.toHaveBeenCalled();
		expect(result).toEqual({
			process: fakeProcess,
			source: "direct",
			launchVariant: "native-ts7",
		});
	});

	it("uses a TypeScript 7 compiler hoisted above the nearest package root", async () => {
		const workspaceRoot = makeProject("7.0.2");
		const command = addNativeTsc(workspaceRoot);
		const { packageRoot, sourceFile } = addWorkspacePackage(workspaceRoot);

		const detectedRoot = await TypeScriptServer.root(sourceFile);
		expect(path.resolve(detectedRoot as string)).toBe(
			path.resolve(packageRoot),
		);

		const result = await TypeScriptServer.spawn(detectedRoot as string, {
			allowInstall: false,
		});

		expect(launchLSP).toHaveBeenCalledWith(command, ["--lsp", "--stdio"], {
			cwd: packageRoot,
			env: { PI_LENS_TEST_TOOLCHAIN: "1" },
		});
		expect(ensureTool).not.toHaveBeenCalled();
		expect(result).toEqual({
			process: fakeProcess,
			source: "direct",
			launchVariant: "native-ts7",
		});
	});

	it("keeps TypeScript 6 on typescript-language-server and tsserver", async () => {
		const root = makeProject("6.0.3");
		addNativeTsc(root);
		const { lspPath, tsserverPath } = addClassicServer(root);

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchLSP).toHaveBeenCalledWith(lspPath, ["--stdio"], {
			cwd: root,
			env: {
				PI_LENS_TEST_TOOLCHAIN: "1",
				TSSERVER_PATH: tsserverPath,
				...ownedTempEnvironment(),
			},
		});
		expect(result?.initialization).toEqual({
			tsserver: { path: tsserverPath },
		});
		expect(result?.launchVariant).toBe("classic");
	});

	it("does not skip a nearer TypeScript 6 package for an ancestor TypeScript 7 package", async () => {
		const workspaceRoot = makeProject("7.0.2");
		addNativeTsc(workspaceRoot);
		const { packageRoot } = addWorkspacePackage(workspaceRoot);
		addTypeScriptPackage(packageRoot, "6.0.3");
		addNativeTsc(packageRoot);
		const { lspPath, tsserverPath } = addClassicServer(packageRoot);

		const result = await TypeScriptServer.spawn(packageRoot, {
			allowInstall: false,
		});

		expect(launchLSP).toHaveBeenCalledWith(lspPath, ["--stdio"], {
			cwd: packageRoot,
			env: {
				PI_LENS_TEST_TOOLCHAIN: "1",
				TSSERVER_PATH: tsserverPath,
				...ownedTempEnvironment(),
			},
		});
		expect(result?.initialization).toEqual({
			tsserver: { path: tsserverPath },
		});
	});

	it("refuses the classic wrapper without a compiler when TypeScript 7 has no local tsc binary", async () => {
		const root = makeProject("7.0.2");
		addClassicWrapper(root);
		const previousCwd = process.cwd();
		process.chdir(root);
		try {
			const result = await TypeScriptServer.spawn(root, {
				allowInstall: false,
			});

			expect(launchLSP).not.toHaveBeenCalled();
			expect(ensureTool).toHaveBeenCalledWith("typescript", {
				allowInstall: false,
			});
			expect(result).toBeUndefined();
		} finally {
			process.chdir(previousCwd);
		}
	});

	it("falls back safely when the nearest TypeScript package metadata is malformed", async () => {
		const root = makeProject("7.0.2");
		fs.writeFileSync(
			path.join(root, "node_modules", "typescript", "package.json"),
			"{",
		);
		addNativeTsc(root);
		addClassicServer(root);

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchLSP).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	});

	// Copilot review (PR #526): a nearer `node_modules/typescript/` directory
	// that exists but has no `package.json` (a broken/partial install) must be
	// treated as malformed AT THAT LEVEL and stop the walk — never silently
	// skipped as "not installed here" in favor of an ancestor TS 7 hoist. That
	// would violate "nearest package shadows ancestors" for exactly the
	// malformed-install case the doc comment already calls out.
	it("does not skip a nearer TypeScript install whose package.json is missing (directory exists) to select an ancestor TS 7 hoist", async () => {
		const workspaceRoot = makeProject("7.0.2"); // ancestor: valid TS 7 install
		addNativeTsc(workspaceRoot);
		const { packageRoot } = addWorkspacePackage(workspaceRoot);

		// Nearer install: the `typescript` directory exists (e.g. a partial /
		// interrupted install) but package.json is missing entirely.
		fs.mkdirSync(path.join(packageRoot, "node_modules", "typescript"), {
			recursive: true,
		});
		addClassicServer(packageRoot);

		const result = await TypeScriptServer.spawn(packageRoot, {
			allowInstall: false,
		});

		// #4299: broken metadata cannot authorize an implicit classic fallback,
		// and the nearer install still shadows the ancestor native compiler.
		expect(launchLSP).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	});
});
