/**
 * `echoriad status` — report the guest-image state of the project at cwd.
 *
 * Computes the selected source (project / system / env / default, with
 * the resolved build-config path or selector value), the current build
 * fingerprint, and one verdict: up to date, needs build, needs approval,
 * or no image selected. Status never prompts and never builds; a
 * build-config selection is only read, fingerprinted, and looked up in
 * Gondolin's store and the authorization metadata.
 */

import fs from "node:fs";
import path from "node:path";
import { type BuildConfig, parseBuildConfig, resolveImageSelector } from "@earendil-works/gondolin";
import {
  type AuthorizationAssociation,
  authorizationFilePath,
  findAuthorizedAssociation,
  readAuthorizations,
} from "../authorization.ts";
import {
  type ImageSelection,
  loadProjectConfig,
  loadSystemConfig,
  resolveImageSelection,
  type SystemConfig,
} from "../config.ts";
import { computeBuildFingerprint } from "../fingerprint.ts";
import { GuestImageError, imageRefForFingerprint } from "../guest-image.ts";
import { deriveBuildIdentity } from "../identity.ts";
import type { CommandContext } from "./index.ts";
import { CliError, type Ui } from "./ui.ts";

export type StatusVerdict = "up to date" | "needs build" | "needs approval" | "no image selected";

/** The complete state `status` reports; `--json` carries it verbatim. */
export interface StatusResult {
  /** which configuration selected the image source, and what it selected */
  source: {
    kind: "project" | "system" | "env" | "default";
    /** resolved build-config path or image selector value */
    value?: string;
  };
  /** present only for a build-config selection */
  fingerprint?: {
    /** full hex fingerprint */
    full: string;
    /** first 12 hex characters */
    abbreviated: string;
  };
  verdict: StatusVerdict;
}

/** Injectable seams for `computeStatus`; every field defaults to the real thing. */
export interface StatusDeps {
  loadProjectConfig: typeof loadProjectConfig;
  loadSystemConfig: () => SystemConfig;
  resolveImageSelection: (
    project: ReturnType<typeof loadProjectConfig>,
    system: SystemConfig,
    projectRoot: string,
    envImage: string | undefined,
  ) => ImageSelection;
  readFile: (configPath: string) => string;
  parseBuildConfig: (raw: string) => BuildConfig;
  computeBuildFingerprint: typeof computeBuildFingerprint;
  imageRefForFingerprint: typeof imageRefForFingerprint;
  /** resolves in Gondolin's store; throws when the image is missing */
  resolveImage: (selector: string) => { buildId: string };
  deriveBuildIdentity: typeof deriveBuildIdentity;
  readAuthorizations: (filePath: string) => AuthorizationAssociation[];
  findAuthorizedAssociation: typeof findAuthorizedAssociation;
  authorizationFilePath: () => string;
}

function defaultStatusDeps(): StatusDeps {
  return {
    loadProjectConfig,
    loadSystemConfig,
    resolveImageSelection,
    readFile: (configPath) => fs.readFileSync(configPath, "utf8"),
    parseBuildConfig,
    computeBuildFingerprint,
    imageRefForFingerprint,
    resolveImage: (selector) => {
      const resolved = resolveImageSelector(selector);
      if (!resolved.buildId) {
        throw new Error(`image selector did not resolve to a build id: ${selector}`);
      }
      return { buildId: resolved.buildId };
    },
    deriveBuildIdentity,
    readAuthorizations: (filePath) => readAuthorizations(filePath),
    findAuthorizedAssociation,
    authorizationFilePath,
  };
}

/**
 * Compute the guest-image status of the project at `projectRoot`.
 *
 * A build-config selection is read, fingerprinted, and looked up in
 * Gondolin's store and the authorization metadata; read, parse, and
 * fingerprint failures reuse the build pipeline's `GuestImageError`
 * messages so the CLI's error convention applies to them. Image and
 * default selections carry no fingerprint and report `no image
 * selected`.
 */
export function computeStatus(
  projectRoot: string,
  envImage: string | undefined,
  overrides: Partial<StatusDeps> = {},
): StatusResult {
  const deps: StatusDeps = { ...defaultStatusDeps(), ...overrides };
  const project = deps.loadProjectConfig(projectRoot);
  const system = deps.loadSystemConfig();
  const selection = deps.resolveImageSelection(project, system, projectRoot, envImage);

  if (selection.kind === "image" || selection.kind === "default") {
    return {
      source: {
        kind: selection.kind === "default" ? "default" : selection.origin,
        value: selection.kind === "image" ? selection.value : undefined,
      },
      verdict: "no image selected",
    };
  }

  let raw: string;
  try {
    raw = deps.readFile(selection.configPath);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") {
      throw new GuestImageError(
        `Echoriad: build config ${selection.configPath} does not exist; ` +
          `check the "buildConfig" path in the configuration that declared it`,
        { permanent: true },
      );
    }
    throw new GuestImageError(
      `Echoriad: build config ${selection.configPath} could not be read: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { permanent: true },
    );
  }
  let config: BuildConfig;
  try {
    config = deps.parseBuildConfig(raw);
  } catch (error) {
    throw new GuestImageError(
      `Echoriad: build config ${selection.configPath} was rejected by Gondolin: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { permanent: true },
    );
  }
  let fp: ReturnType<typeof computeBuildFingerprint>;
  try {
    fp = deps.computeBuildFingerprint(config, path.dirname(selection.configPath));
  } catch (error) {
    throw new GuestImageError(error instanceof Error ? error.message : String(error), {
      permanent: true,
    });
  }
  const imageRef = deps.imageRefForFingerprint(fp.fingerprint);

  const identity = deps.deriveBuildIdentity({
    origin: selection.origin,
    projectRoot,
    configPath: selection.configPath,
  });

  let cached: { buildId: string } | undefined;
  try {
    cached = deps.resolveImage(imageRef);
  } catch {
    cached = undefined;
  }

  const associations = deps.readAuthorizations(deps.authorizationFilePath());
  const authorized = deps.findAuthorizedAssociation(
    associations,
    identity.consumerId,
    identity.configId,
    fp.fingerprint,
  );

  let verdict: StatusVerdict;
  if (!cached) {
    verdict = "needs build";
  } else if (!authorized || authorized.buildId !== cached.buildId) {
    verdict = "needs approval";
  } else {
    verdict = "up to date";
  }

  return {
    source: { kind: selection.origin, value: selection.configPath },
    fingerprint: { full: fp.fingerprint, abbreviated: fp.abbreviated },
    verdict,
  };
}

/**
 * The `status` command handler: report the project's guest-image state
 * through the ui seam. `--json` carries the complete state including
 * the full fingerprint; the human form shows the abbreviated one.
 */
export function statusCommand(args: string[], ui: Ui, ctx: CommandContext): void {
  const unknown = args.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    throw new CliError(`unknown option "${unknown[0]}" for status`);
  }
  const result = computeStatus(ctx.cwd, ctx.env.ECHORIAD_IMAGE, {
    loadSystemConfig: () => ctx.system,
  });

  if (args.includes("--json")) {
    ui.line(JSON.stringify(result, null, 2));
    return;
  }

  const source =
    result.source.value === undefined
      ? result.source.kind
      : `${result.source.kind} (${result.source.value})`;
  ui.line(`source: ${source}`);
  if (result.fingerprint) {
    ui.line(`fingerprint: ${result.fingerprint.abbreviated}`);
  }
  ui.line(`verdict: ${result.verdict}`);
}
