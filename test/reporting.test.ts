import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@earendil-works/pi-coding-agent") {
			return { url: new URL("./fixtures/pi-tools.ts", import.meta.url).href, shortCircuit: true };
		}
		if (
			(specifier === "@earendil-works/gondolin" && !context.parentURL?.includes("node_modules")) ||
			(specifier === "node:child_process" && context.parentURL?.endsWith("/src/guest-image.ts"))
		) {
			return {
				url: new URL("./fixtures/extension-boundaries.ts", import.meta.url).href,
				shortCircuit: true,
			};
		}
		return next(specifier, context);
	},
});
const { state } = await import("./fixtures/extension-boundaries.ts");
const { default: extension } = await import("../index.ts");

type TestHarness = {
	dir: string;
	notifications: string[];
	commands: Map<string, any>;
	handlers: Map<string, (...args: never[]) => unknown>;
	ctx: any;
	runEchoriadCommand: () => Promise<string>;
	cleanup: () => void;
};

async function setup(): Promise<TestHarness> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-report-"));
	const originalCwd = process.cwd();
	const oldCache = process.env.XDG_CACHE_HOME;
	const oldConfig = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CACHE_HOME = path.join(dir, "cache");
	process.env.XDG_CONFIG_HOME = path.join(dir, "config");
	process.chdir(dir);

	const notifications: string[] = [];
	const handlers = new Map<string, (...args: never[]) => unknown>();
	const commands = new Map<string, any>();
	extension({
		on: (name, fn) => handlers.set(name, fn),
		registerTool: () => {},
		registerCommand: (name, command) => commands.set(name, command),
	} as any);
	const ctx = {
		hasUI: true,
		ui: {
			confirm: async () => true,
			notify: (s: string) => notifications.push(s),
			setStatus: () => {},
			theme: { fg: (_color: string, s: string) => s },
		},
	};

	const harness: TestHarness = {
		dir,
		notifications,
		commands,
		handlers,
		ctx,
		async runEchoriadCommand() {
			const before = notifications.length;
			await commands.get("echoriad")!.handler({}, ctx);
			return notifications.slice(before).join("\n");
		},
		cleanup() {
			process.chdir(originalCwd);
			if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
			else process.env.XDG_CACHE_HOME = oldCache;
			if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = oldConfig;
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
	return harness;
}

/** Register a second extension instance sharing the harness environment. */
function spawnInstance(
	h: TestHarness,
	confirm?: (action: unknown) => Promise<boolean>,
): {
	handlers: Map<string, (...args: never[]) => unknown>;
	commands: Map<string, any>;
	ctx: any;
} {
	const handlers = new Map<string, (...args: never[]) => unknown>();
	const commands = new Map<string, any>();
	extension({
		on: (name, fn) => handlers.set(name, fn),
		registerTool: () => {},
		registerCommand: (name, command) => commands.set(name, command),
	} as any);
	const ctx = {
		hasUI: true,
		ui: {
			confirm: confirm ?? (async () => true),
			notify: (s: string) => h.notifications.push(s),
			setStatus: () => {},
			theme: { fg: (_color: string, s: string) => s },
		},
	};
	return { handlers, commands, ctx };
}

const fixtureCli = path.resolve("test/fixtures/build-child.mjs");

function writeBuildProject(dir: string): void {
	fs.writeFileSync(path.join(dir, "init.sh"), "#!/bin/sh\n");
	fs.writeFileSync(path.join(dir, ".echoriad.json"), JSON.stringify({ buildConfig: "build.json" }));
	fs.writeFileSync(
		path.join(dir, "build.json"),
		JSON.stringify({
			arch: "aarch64",
			distro: "alpine",
			alpine: { version: "3.23.0" },
			init: { rootfsInit: "init.sh" },
		}),
	);
}

/** Start a session that performs a fresh (uncached) build. */
async function startSession(h: TestHarness): Promise<void> {
	state.cliPath = fixtureCli;
	state.mode = "success";
	state.imported = false;
	await h.handlers.get("session_start")!({}, h.ctx);
}

test("/echoriad keeps the existing report for a direct image selector", async () => {
	const h = await setup();
	try {
		fs.writeFileSync(
			path.join(h.dir, ".echoriad.json"),
			JSON.stringify({ image: "fixture-direct:latest" }),
		);
		state.cliPath = fixtureCli;
		await h.handlers.get("session_start")!({}, h.ctx);
		const report = await h.runEchoriadCommand();
		assert.match(report, /Gondolin VM: fixture-vm/);
		assert.match(report, /Host workspace:/);
		assert.match(report, /Guest workspace: \/workspace/);
		assert.match(report, /Shell: /);
		assert.match(report, /Image: fixture-direct:latest/);
		assert.doesNotMatch(report, /Build config:/);
		assert.doesNotMatch(report, /Fingerprint:/);
		assert.doesNotMatch(report, /Gondolin build ID:/);
		assert.doesNotMatch(report, /Image source:/);
	} finally {
		h.cleanup();
	}
});

test("/echoriad reports build config, fingerprint, build ID, and built for a new build", async () => {
	const h = await setup();
	try {
		writeBuildProject(h.dir);
		await startSession(h);
		const report = await h.runEchoriadCommand();
		assert.match(report, /Build config: .+build\.json/);
		assert.match(report, /Fingerprint: [0-9a-f]{12}(?![0-9a-f])/);
		assert.match(report, /Gondolin build ID: fixture-build-id/);
		assert.match(report, /Image source: built at startup/);
	} finally {
		h.cleanup();
	}
});

test("/echoriad reports a reused image after a cached build", async () => {
	const h = await setup();
	try {
		writeBuildProject(h.dir);
		await startSession(h);
		// Second session, same cache: silent authorized reuse (no approval).
		const second = spawnInstance(h, async () => {
			throw new Error("silent reuse must not prompt");
		});
		await second.handlers.get("session_start")!({}, second.ctx);
		const before = h.notifications.length;
		await second.commands.get("echoriad")!.handler({}, second.ctx);
		const report = h.notifications.slice(before).join("\n");
		assert.match(report, /Build config: .+build\.json/);
		assert.match(report, /Fingerprint: [0-9a-f]{12}(?![0-9a-f])/);
		assert.match(report, /Gondolin build ID: fixture-build-id/);
		assert.match(report, /Image source: reused cached image/);
	} finally {
		h.cleanup();
	}
});

test("/echoriad reports an unavailable guest without host details", async () => {
	const h = await setup();
	try {
		writeBuildProject(h.dir);
		h.ctx.ui.confirm = async () => false;
		state.cliPath = fixtureCli;
		state.imported = false;
		await assert.rejects(h.handlers.get("session_start")!({}, h.ctx));
		const report = await h.runEchoriadCommand();
		assert.match(report, /guest unavailable/);
		assert.doesNotMatch(report, /build\.json/);
		assert.doesNotMatch(report, /Fingerprint:/);
		assert.doesNotMatch(report, /fixture-build-id/);
	} finally {
		h.cleanup();
	}
});

test("build reporting keeps local inputs, logs, and authorization out of output and prompt", async () => {
	const h = await setup();
	try {
		writeBuildProject(h.dir);
		await startSession(h);
		const report = await h.runEchoriadCommand();
		// The build config path is reported; the declared local input, the
		// Gondolin build output, and the authorization store are not.
		assert.match(report, /Build config: .+build\.json/);
		assert.doesNotMatch(report, /init\.sh/);
		assert.doesNotMatch(report, /stderr fixture/);
		assert.doesNotMatch(report, /image-authorizations/);
		assert.doesNotMatch(report, /Consumer:/);
		// The system prompt keeps the guest workspace line and none of the
		// build details.
		const event = { systemPrompt: `Current working directory: ${h.dir}` };
		const result = await h.handlers.get("before_agent_start")!(event, h.ctx);
		assert.match(result.systemPrompt, /Guest:|Gondolin VM/);
		assert.doesNotMatch(result.systemPrompt, /init\.sh/);
		assert.doesNotMatch(result.systemPrompt, /stderr fixture/);
		assert.doesNotMatch(result.systemPrompt, /Fingerprint/);
		assert.doesNotMatch(result.systemPrompt, /image-authorizations/);
	} finally {
		h.cleanup();
	}
});
