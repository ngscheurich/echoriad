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
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  parseBuildConfig,
  resolveImageSelector,
  type BuildConfig,
} from "@earendil-works/gondolin";
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

export type ApprovalSummaryInput = {
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
    lines.push(
      "Warning: postBuild commands may see inherited host environment variables.",
    );
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
  consumer: string;
  interactive: boolean;
  approve: (summary: string) => Promise<boolean>;
  onStatus?: (message: string) => void;
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
  fingerprint: (config: BuildConfig, configDir: string) => ReturnType<typeof computeBuildFingerprint>;
  resolveImage: (selector: string) => { buildId: string };
  build: (
    command: BuildCommandInput,
    onOutput?: (chunk: string) => void,
    onBuildFailure?: (outputTail: string) => void,
  ) => Promise<void>;
  makeOutputDir: () => string;
  removeOutputDir: (dir: string) => void;
};

function defaultDeps(): GuestImageDeps {
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
    build: async (command, onOutput) => {
      await runGondolinBuild(command, onOutput);
    },
    makeOutputDir: () =>
      fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-build-")),
    removeOutputDir: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Bounded tail of Gondolin's output for inclusion in a build-failure error,
 * so the human-facing error carries the actual failure instead of only the
 * exit code. Never enters model context: errors surface through pi's
 * extension error log and notifications only.
 */
export function tailOfOutput(
  output: string,
  maxLines = 12,
  maxChars = 4000,
): string {
  const lines = output.split("\n").map((line) => line.replace(/\r$/, ""));
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }
  const tail = lines.slice(-maxLines).join("\n");
  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}

export async function runGondolinBuild(
  command: BuildCommandInput,
  onOutput?: (chunk: string) => void,
  onBuildFailure?: (outputTail: string) => void,
): Promise<void> {
  const args = buildCommandArgs(command);
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Combined stdout/stderr, capped, kept only for the failure tail.
  let collected = "";
  const collect = (chunk: Buffer) => {
    const text = chunk.toString();
    onOutput?.(text);
    collected = (collected + text).slice(-65536);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const exitCode: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
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
 * Fails closed: a noninteractive session or a denied prompt stops startup
 * before any build or image selection.
 */
export async function prepareGuestImage(
  options: PrepareGuestImageOptions,
): Promise<GuestImageResult> {
  const deps = { ...defaultDeps(), ...options.deps };

  if (!options.interactive) {
    throw new GuestImageError(
      "Echoriad: the selected build config requires approval before building, " +
        "but this session is noninteractive. Open the project interactively to approve the build.",
      { permanent: true },
    );
  }

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

  const summary = buildApprovalSummary({
    consumer: options.consumer,
    projectRoot: options.projectRoot,
    configPath,
    localInputPaths: fp.localInputPaths,
    config,
  });
  const approved = await options.approve(summary);
  if (!approved) {
    throw new GuestImageError(
      "Echoriad: guest image build was not approved; VM startup stopped.",
      { permanent: true },
    );
  }

  // A valid image object behind the fingerprint reference allows reuse.
  let cached: { buildId: string } | undefined;
  try {
    cached = deps.resolveImage(imageRef);
  } catch {
    cached = undefined;
  }
  if (cached) {
    options.onStatus?.(
      `reusing guest image ${fp.abbreviatedFingerprint}`,
    );
    return {
      imageSelector: cached.buildId,
      fingerprint: fp.fingerprint,
      abbreviatedFingerprint: fp.abbreviated,
      imageRef,
      buildId: cached.buildId,
      built: false,
      configPath,
    };
  }

  options.onStatus?.(`building guest image ${fp.abbreviatedFingerprint}`);
  const outputDir = deps.makeOutputDir();
  try {
    await deps.build(
      { cliPath: resolveGondolinCli().cliPath, configPath, outputDir, imageRef },
      options.onBuildOutput,
      options.onBuildFailure,
    );
    // Only trust the image after the import is resolved to a build id.
    const resolved = deps.resolveImage(imageRef);
    return {
      imageSelector: resolved.buildId,
      fingerprint: fp.fingerprint,
      abbreviatedFingerprint: fp.abbreviated,
      imageRef,
      buildId: resolved.buildId,
      built: true,
      configPath,
    };
  } finally {
    deps.removeOutputDir(outputDir);
  }
}
