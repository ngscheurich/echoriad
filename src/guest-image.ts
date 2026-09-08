/**
 * Automatic guest image builds from a selected Gondolin build config.
 *
 * Echoriad owns source selection, approval, fingerprinting, and build
 * process lifecycle; Gondolin owns image composition and its build-config
 * schema. Build output, resolved host paths, approval details, and errors
 * stay in human-facing channels and never enter model context.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { type BuildConfig, parseBuildConfig, resolveImageSelector } from "@earendil-works/gondolin";
import {
	type AuthorizationAssociation,
	authorizationFilePath,
	findAuthorizedAssociation,
	readAuthorizations,
	saveAssociation,
} from "./authorization.ts";
import { computeBuildFingerprint, gondolinVersion } from "./fingerprint.ts";

/** Errors that must keep failing on every startup attempt (fail closed). */
export class GuestImageError extends Error {
	readonly permanent: boolean;
	constructor(message: string, options?: { permanent?: boolean }) {
		super(message);
		this.name = "GuestImageError";
		this.permanent = options?.permanent ?? false;
	}
}

let cachedCli: { cliPath: string; version: string } | undefined;

/** Resolve the bundled Gondolin CLI from the package dependency, not PATH. */
export function resolveGondolinCli(): { cliPath: string; version: string } {
	if (cachedCli) return cachedCli;
	const require = createRequire(import.meta.url);
	const packageJsonPath = require.resolve("@earendil-works/gondolin/package.json");
	const packageDir = path.dirname(packageJsonPath);
	const cliPath = path.join(packageDir, "dist", "bin", "gondolin.js");
	if (!fs.existsSync(cliPath)) {
		throw new GuestImageError(
			`Echoriad: the Gondolin CLI is missing from the installed ` +
				`@earendil-works/gondolin package (expected ${cliPath}); reinstall the dependency`,
		);
	}
	cachedCli = { cliPath, version: gondolinVersion() };
	return cachedCli;
}

/** Internal Gondolin image reference derived from a build fingerprint. */
export function imageRefForFingerprint(fingerprint: string): string {
	return `echoriad-build-${fingerprint}:latest`;
}

export type BuildCommandInput = {
	cliPath: string;
	configPath: string;
	outputDir: string;
	imageRef: string;
};

/**
 * The Gondolin build command Echoriad launches: the selected build config,
 * a unique temporary output directory, and the fingerprint-derived image
 * reference.
 */
export function buildCommandArgs(input: BuildCommandInput): string[] {
	return [
		input.cliPath,
		"build",
		"--config",
		input.configPath,
		"--output",
		input.outputDir,
		"--tag",
		input.imageRef,
	];
}

function hasPostBuildCommands(config: BuildConfig): boolean {
	return (config.postBuild?.commands?.length ?? 0) > 0;
}

function detectHostArchitecture(): "aarch64" | "x86_64" | undefined {
	if (process.arch === "arm64") return "aarch64";
	if (process.arch === "x64") return "x86_64";
	return undefined;
}

/** Whether the build may run in a container with elevated privileges. */
export function mayUsePrivilegedContainer(config: BuildConfig): boolean {
	// Gondolin's builder runs container builds with --privileged only when
	// postBuild commands are present, and only builds in a container when
	// forced, when the host cannot run the build natively (non-Linux with
	// postBuild commands), or on a macOS host with a mismatched target arch.
	if (!hasPostBuildCommands(config)) return false;
	if (config.container?.force) return true;
	if (config.oci) return false;
	return process.platform !== "linux" || detectHostArchitecture() !== config.arch;
}

/** Whether a prompt asks to build the image or reuse a cached one. */
export type ApprovalAction = "build" | "reuse";

export type ApprovalSummaryInput = {
	action: ApprovalAction;
	consumer: string;
	projectRoot: string;
	configPath: string;
	localInputPaths: string[];
	config: BuildConfig;
};

/**
 * Human-facing approval prompt body. Shows the consumer and project root,
 * the canonical build-config path, all resolved local input paths
 * (highlighting paths outside the project), postBuild commands verbatim,
 * image references, and the required access warnings. The dialog renders
 * plain text, so labels stay unadorned and the trailing access warnings
 * are separated as one paragraph by a blank line.
 */
export function buildApprovalSummary(input: ApprovalSummaryInput): string {
	const lines: string[] = [];
	lines.push(
		input.action === "build"
			? "Action: build the guest image from this build config"
			: "Action: reuse the globally cached image built from this build config",
	);
	lines.push(`Consumer: ${input.consumer}`);
	lines.push(`Project root: ${input.projectRoot}`);
	lines.push(`Build config: ${input.configPath}`);

	if (input.localInputPaths.length > 0) {
		lines.push("Local inputs:");
		for (const inputPath of input.localInputPaths) {
			const outside = path.relative(input.projectRoot, inputPath).startsWith("..")
				? " (outside project)"
				: "";
			lines.push(`  - ${inputPath}${outside}`);
		}
	} else {
		lines.push("Local inputs: none");
	}

	const commands = input.config.postBuild?.commands ?? [];
	if (commands.length > 0) {
		lines.push("postBuild.commands (verbatim):");
		for (const command of commands) {
			lines.push(`  ${command}`);
		}
		// postBuild commands run in a chroot that inherits host environment
		// variables; Gondolin cannot filter them in this release.
		lines.push("Warning: postBuild commands may see inherited host environment variables.");
	}

	if (input.config.oci?.image) {
		lines.push(`OCI image: ${input.config.oci.image}`);
	}
	if (input.config.container?.image) {
		lines.push(`Container image: ${input.config.container.image}`);
	}

	const initScripts = [
		input.config.init?.rootfsInit,
		input.config.init?.initramfsInit,
		input.config.init?.rootfsInitExtra,
	].filter((value): value is string => Boolean(value));
	if (initScripts.length > 0) {
		lines.push(`Init scripts: ${initScripts.join(", ")}`);
	}
	const sandboxHelpers = [
		input.config.sandboxdPath,
		input.config.sandboxfsPath,
		input.config.sandboxsshPath,
		input.config.sandboxingressPath,
	].filter((value): value is string => Boolean(value));
	if (sandboxHelpers.length > 0) {
		lines.push(`Sandbox helpers: ${sandboxHelpers.join(", ")}`);
	}

	if (mayUsePrivilegedContainer(input.config)) {
		lines.push("Container: Gondolin may run this build in a privileged container.");
	}
	lines.push("");
	lines.push(
		"Building uses host network access independently of guest network policy. " +
			"The Gondolin process inherits the host environment. " +
			"Build output may contain host data.",
	);
	return lines.join("\n");
}

export type GuestImageResult = {
	/** selector to start the VM from (the imported content-derived build id) */
	imageSelector: string;
	/** full hex fingerprint */
	fingerprint: string;
	/** abbreviated fingerprint for reporting */
	abbreviatedFingerprint: string;
	/** internal fingerprint-derived Gondolin image reference */
	imageRef: string;
	/** Gondolin build id backing the image */
	buildId: string;
	/** whether this startup built the image (false = reused a cached build) */
	built: boolean;
	/** canonical build-config path used for the build */
	configPath: string;
};

export type PrepareGuestImageOptions = {
	configPath: string;
	projectRoot: string;
	/** human-facing consumer label for the approval prompt */
	consumer: string;
	/** canonical consumer identity for authorization metadata */
	consumerId: string;
	/** build-config identity for authorization metadata */
	configId: string;
	interactive: boolean;
	signal?: AbortSignal;
	approve: (action: ApprovalAction, summary: string) => Promise<boolean>;
	onStatus?: (message: string) => void;
	/** human-facing warnings, for example malformed authorization metadata */
	onWarning?: (message: string) => void;
	onBuildOutput?: (chunk: string) => void;
	/**
	 * Called with the tail of Gondolin's output when a build fails. The error
	 * thrown to stop startup stays one line, because pi's extension-error log
	 * prints the message and the stack (which embeds the message) and would
	 * otherwise duplicate every line.
	 */
	onBuildFailure?: (outputTail: string) => void;
	/** test overrides */
	deps?: Partial<GuestImageDeps>;
};

export type GuestImageDeps = {
	readConfig: (configPath: string) => string;
	parseConfig: (raw: string, configPath: string) => BuildConfig;
	fingerprint: (
		config: BuildConfig,
		configDir: string,
	) => ReturnType<typeof computeBuildFingerprint>;
	resolveImage: (selector: string) => { buildId: string };
	build: (
		command: BuildCommandInput,
		onOutput?: (chunk: string) => void,
		onBuildFailure?: (outputTail: string) => void,
		signal?: AbortSignal,
	) => Promise<void>;
	makeOutputDir: () => string;
	removeOutputDir: (dir: string) => void;
	/** read the consumer authorization metadata (missing cache reads empty) */
	readAuthorizations: () => AuthorizationAssociation[];
	/** record one authorization association after a successful build or an
	 * approved cache reuse */
	writeAuthorization: (association: AuthorizationAssociation) => void;
};

function defaultDeps(options: PrepareGuestImageOptions): GuestImageDeps {
	return {
		readConfig: (configPath) => fs.readFileSync(configPath, "utf8"),
		parseConfig: (raw, configPath) => {
			try {
				return parseBuildConfig(raw);
			} catch (error) {
				throw new GuestImageError(
					`Echoriad: build config ${configPath} was rejected by Gondolin: ` +
						`${(error as Error).message}`,
					{ permanent: true },
				);
			}
		},
		fingerprint: computeBuildFingerprint,
		resolveImage: (selector) => {
			const resolved = resolveImageSelector(selector);
			if (!resolved.buildId) {
				throw new Error(`image selector did not resolve to a build id: ${selector}`);
			}
			return { buildId: resolved.buildId };
		},
		build: runGondolinBuild,
		makeOutputDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-build-")),
		removeOutputDir: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
		readAuthorizations: () => readAuthorizations(authorizationFilePath(), options.onWarning),
		writeAuthorization: (association) =>
			saveAssociation(authorizationFilePath(), association, options.onWarning),
	};
}

/**
 * Bounded tail of Gondolin's output for inclusion in a build-failure error,
 * so the human-facing error carries the actual failure instead of only the
 * exit code. Never enters model context: errors surface through pi's
 * extension error log and notifications only.
 */
export function tailOfOutput(output: string, maxLines = 12, maxChars = 4000): string {
	const lines = output.split("\n").map((line) => line.replace(/\r$/, ""));
	while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
		lines.pop();
	}
	const tail = lines.slice(-maxLines).join("\n");
	return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}

function checkBuildCancellation(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new GuestImageError("Echoriad: guest image build cancelled");
	}
}

export async function runGondolinBuild(
	command: BuildCommandInput,
	onOutput?: (chunk: string) => void,
	onBuildFailure?: (outputTail: string) => void,
	signal?: AbortSignal,
): Promise<void> {
	checkBuildCancellation(signal);
	const args = buildCommandArgs(command);
	const child = spawn(process.execPath, args, {
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	let termination: Promise<void> | undefined;
	const killGroup = (signal: NodeJS.Signals) => {
		if (!child.pid) return;
		try {
			process.kill(-child.pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	};
	const cancel = () => {
		if (termination) return;
		killGroup("SIGTERM");
		// Escalate even if the leader exits: descendants may ignore SIGTERM.
		termination = new Promise((resolve) => {
			setTimeout(() => {
				killGroup("SIGKILL");
				resolve();
			}, 1000);
		});
	};
	signal?.addEventListener("abort", cancel, { once: true });
	if (signal?.aborted) cancel();
	// Combined stdout/stderr, capped, kept only for the failure tail.
	let collected = "";
	const collect = (chunk: Buffer) => {
		const text = chunk.toString();
		onOutput?.(text);
		collected = (collected + text).slice(-65536);
	};
	child.stdout.on("data", collect);
	child.stderr.on("data", collect);
	let exitCode: number;
	try {
		exitCode = await new Promise<number>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (code) => resolve(code ?? -1));
		});
	} finally {
		signal?.removeEventListener("abort", cancel);
		await termination;
	}
	checkBuildCancellation(signal);
	if (exitCode !== 0) {
		// The tail goes to a human-facing notification; the thrown error stays
		// short so the extension-error log does not repeat it.
		onBuildFailure?.(tailOfOutput(collected));
		throw new GuestImageError(
			`Echoriad: guest image build failed (Gondolin exited with code ${exitCode})`,
		);
	}
}

/**
 * Resolve or build the guest image for a selected build config.
 *
 * The internal fingerprint-derived image reference is resolved in
 * Gondolin's store before building, so any consumer with matching inputs
 * can reuse a global build. Silent reuse requires an authorized
 * association (consumer, build-config identity, fingerprint, build ID)
 * with a valid image object; a new consumer reusing a global image and an
 * uncached fingerprint both require approval. A missing Gondolin object
 * makes the cache entry unusable: Echoriad prompts and rebuilds, and never
 * falls back to an image produced for an older fingerprint.
 *
 * Fails closed: a noninteractive session that requires approval stops
 * startup before building or selecting the image; a denied prompt stops
 * startup.
 */
export async function prepareGuestImage(
	options: PrepareGuestImageOptions,
): Promise<GuestImageResult> {
	try {
		return await prepareImage(options);
	} catch (error) {
		options.onStatus?.(
			options.signal?.aborted ? "guest image build cancelled" : "guest image preparation failed",
		);
		throw error;
	}
}

async function prepareImage(options: PrepareGuestImageOptions): Promise<GuestImageResult> {
	checkBuildCancellation(options.signal);
	const deps = { ...defaultDeps(options), ...options.deps };

	const { configPath } = options;
	let stat: fs.Stats;
	try {
		stat = fs.statSync(configPath);
	} catch {
		throw new GuestImageError(
			`Echoriad: build config ${configPath} does not exist; ` +
				`check the "buildConfig" path in the configuration that declared it`,
			{ permanent: true },
		);
	}
	if (!stat.isFile()) {
		throw new GuestImageError(
			`Echoriad: build config ${configPath} is not a regular file; ` +
				`"buildConfig" must point at a Gondolin build config JSON file`,
			{ permanent: true },
		);
	}
	let raw: string;
	try {
		raw = deps.readConfig(configPath);
	} catch (error) {
		throw new GuestImageError(
			`Echoriad: build config ${configPath} could not be read: ${(error as Error).message}`,
			{ permanent: true },
		);
	}
	const config = deps.parseConfig(raw, configPath);
	const configDir = path.dirname(configPath);

	// Echoriad hashes declared local inputs before approval.
	const fp = deps.fingerprint(config, configDir);
	const imageRef = imageRefForFingerprint(fp.fingerprint);

	// Resolve internal Gondolin image references by fingerprint before
	// building: a valid image object behind the fingerprint reference is a
	// globally reusable build.
	let cached: { buildId: string } | undefined;
	try {
		cached = deps.resolveImage(imageRef);
	} catch {
		cached = undefined;
	}

	// A matching authorized association permits silent cache reuse.
	const associations = deps.readAuthorizations();
	const authorized = findAuthorizedAssociation(
		associations,
		options.consumerId,
		options.configId,
		fp.fingerprint,
	);

	const result = (image: { buildId: string }, built: boolean): GuestImageResult => ({
		imageSelector: image.buildId,
		fingerprint: fp.fingerprint,
		abbreviatedFingerprint: fp.abbreviated,
		imageRef,
		buildId: image.buildId,
		built,
		configPath,
	});

	if (authorized && cached) {
		options.onStatus?.(`reusing authorized guest image ${fp.abbreviated}`);
		return result(cached, false);
	}

	const action: ApprovalAction = cached ? "reuse" : "build";

	if (!options.interactive) {
		throw new GuestImageError(
			"Echoriad: the selected build config requires approval before " +
				(action === "reuse" ? "reusing the cached guest image" : "building the guest image") +
				", but this session is noninteractive. " +
				"Open the project interactively to approve it.",
			{ permanent: true },
		);
	}

	const summary = buildApprovalSummary({
		action,
		consumer: options.consumer,
		projectRoot: options.projectRoot,
		configPath,
		localInputPaths: fp.localInputPaths,
		config,
	});
	const approved = await options.approve(action, summary);
	checkBuildCancellation(options.signal);
	if (!approved) {
		throw new GuestImageError(
			"Echoriad: the guest image request was not approved; VM startup stopped.",
			{ permanent: true },
		);
	}

	if (cached) {
		// Approval lets this consumer adopt the globally cached image.
		options.onStatus?.(`reusing cached guest image ${fp.abbreviated}`);
		deps.writeAuthorization({
			consumer: options.consumerId,
			config: options.configId,
			fingerprint: fp.fingerprint,
			buildId: cached.buildId,
		});
		return result(cached, false);
	}

	options.onStatus?.(`building guest image ${fp.abbreviated}`);
	checkBuildCancellation(options.signal);
	const outputDir = deps.makeOutputDir();
	try {
		await deps.build(
			{ cliPath: resolveGondolinCli().cliPath, configPath, outputDir, imageRef },
			options.onBuildOutput,
			options.onBuildFailure,
			options.signal,
		);
		checkBuildCancellation(options.signal);
		// Only trust the image after the import is resolved to a build id, and
		// only record authorization after Gondolin imported the image and
		// Echoriad resolved it.
		const resolved = deps.resolveImage(imageRef);
		checkBuildCancellation(options.signal);
		deps.writeAuthorization({
			consumer: options.consumerId,
			config: options.configId,
			fingerprint: fp.fingerprint,
			buildId: resolved.buildId,
		});
		options.onStatus?.(`guest image build complete ${fp.abbreviated}`);
		return result(resolved, true);
	} finally {
		deps.removeOutputDir(outputDir);
	}
}
