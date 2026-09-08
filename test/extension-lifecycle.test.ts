import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const boundaries = new URL("./fixtures/extension-boundaries.ts", import.meta.url).href;
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@earendil-works/pi-coding-agent") {
			return { url: new URL("./fixtures/pi-tools.ts", import.meta.url).href, shortCircuit: true };
		}
		if (
			(specifier === "@earendil-works/gondolin" && !context.parentURL?.includes("node_modules")) ||
			(specifier === "node:child_process" && context.parentURL?.endsWith("/src/guest-image.ts"))
		) {
			return { url: boundaries, shortCircuit: true };
		}
		return next(specifier, context);
	},
});
const { state } = await import("./fixtures/extension-boundaries.ts");
const { default: extension } = await import("../index.ts");
const fixtureCli = path.resolve("test/fixtures/build-child.mjs");

test("Pi routes build failures only to humans and tools fail without host details", async (t) => {
	const original = process.cwd();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-extension-"));
	const oldCache = process.env.XDG_CACHE_HOME;
	const oldConfig = process.env.XDG_CONFIG_HOME;
	t.after(() => {
		process.chdir(original);
		if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = oldCache;
		if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = oldConfig;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	process.env.XDG_CACHE_HOME = path.join(dir, "cache");
	process.env.XDG_CONFIG_HOME = path.join(dir, "config");
	fs.writeFileSync(path.join(dir, ".echoriad.json"), JSON.stringify({ buildConfig: "build.json" }));
	fs.writeFileSync(
		path.join(dir, "build.json"),
		JSON.stringify({ arch: "aarch64", distro: "alpine", alpine: { version: "3.23.0" } }),
	);
	process.chdir(dir);
	const handlers = new Map<string, (...args: never[]) => unknown>();
	const tools: any[] = [];
	const commands = new Map<string, any>();
	const human: string[] = [];
	extension({
		on: (name, fn) => handlers.set(name, fn),
		registerTool: (tool) => tools.push(tool),
		registerCommand: (name, command) => commands.set(name, command),
	} as any);
	const ctx = {
		hasUI: true,
		ui: {
			confirm: async () => true,
			notify: (s: string) => human.push(s),
			setStatus: (_key: string, s: string) => human.push(s),
			theme: { fg: (_color: string, s: string) => s },
		},
	};
	// The fixture's absolute location survives changing the project root.
	state.cliPath = fixtureCli;
	await assert.rejects(handlers.get("session_start")!({}, ctx));
	assert.ok(human.some((s) => s?.includes("stderr fixture")));
	for (const tool of tools) {
		await assert.rejects(tool.execute("id", {}, undefined, undefined, ctx), (error: Error) => {
			assert.equal(error.message, "Echoriad: guest unavailable; see human-facing diagnostics.");
			return true;
		});
	}
	assert.equal(state.created, 0);
	assert.ok(state.outputDirs.every((out) => !fs.existsSync(out)));
});

test("session shutdown terminates an in-flight build and its process group", async (t) => {
	const original = process.cwd();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-shutdown-"));
	const oldCache = process.env.XDG_CACHE_HOME;
	t.after(() => {
		process.chdir(original);
		if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = oldCache;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	process.env.XDG_CACHE_HOME = path.join(dir, "cache");
	fs.writeFileSync(path.join(dir, ".echoriad.json"), JSON.stringify({ buildConfig: "build.json" }));
	fs.writeFileSync(
		path.join(dir, "build.json"),
		JSON.stringify({ arch: "aarch64", distro: "alpine", alpine: { version: "3.23.0" } }),
	);
	process.chdir(dir);
	const handlers = new Map<string, (...args: never[]) => unknown>();
	extension({
		on: (name, fn) => handlers.set(name, fn),
		registerTool: () => {},
		registerCommand: () => {},
	} as any);
	const ctx = {
		hasUI: true,
		ui: {
			confirm: async () => true,
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_c: string, s: string) => s },
		},
	};
	state.cliPath = fixtureCli;
	state.mode = "hang";
	state.lastChildPid = 0;
	const startup = handlers.get("session_start")!({}, ctx);
	// Wait until the fixture child has reported its PID.
	const deadline = Date.now() + 5000;
	while (!state.lastChildPid && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	await handlers.get("session_shutdown")!({}, ctx);
	const started = Date.now();
	await assert.rejects(() => startup, /unavailable|cancelled/);
	// SIGKILL escalation lands after one second; the promise must not wait
	// for the fixture's own three-second sleep.
	assert.ok(Date.now() - started < 2900, "shutdown did not terminate the build promptly");
	const { execFileSync } = await import("node:child_process");
	const processes = execFileSync("ps", ["-o", "pid,stat"], { encoding: "utf8" });
	const line = processes
		.split("\n")
		.map((l) => l.trim().split(/\s+/))
		.find(([id]) => Number(id) === state.lastChildPid);
	assert.ok(!line || line[1]!.startsWith("Z"), `build child survived shutdown: ${line?.[1]}`);
	assert.ok(state.outputDirs.every((out) => !fs.existsSync(out)));
});
