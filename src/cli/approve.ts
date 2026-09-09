/**
 * `echoriad approve` — record a build approval without launching a VM or pi.
 *
 * Approve adopts an existing guest image for the current consumer: it
 * resolves the selection at cwd, computes the fingerprint, renders the
 * same approval summary the extension shows, asks for a decision, and
 * records the association with the build ID the fingerprint resolves to.
 * An association is only ever recorded against an image Gondolin already
 * holds — approving before any image exists would have nothing to attach
 * the approval to, so `approve` fails closed and points at `echoriad build`
 * instead. `--yes` skips the prompt — the human invoking it is the
 * approval — but the summary still prints so script logs record what was
 * approved.
 */

import path from "node:path";
import type { BuildConfig } from "@earendil-works/gondolin";
import {
  type AuthorizationAssociation,
  authorizationFilePath,
  saveAssociation,
} from "../authorization.ts";
import {
  type ImageSelection,
  loadProjectConfig,
  type ProjectConfig,
  resolveImageSelection,
} from "../config.ts";
import { type BuildFingerprint, computeBuildFingerprint } from "../fingerprint.ts";
import {
  buildApprovalSummary,
  GuestImageError,
  imageRefForFingerprint,
  loadBuildConfigFromDisk,
} from "../guest-image.ts";
import { type BuildIdentity, deriveBuildIdentity } from "../identity.ts";
import type { CommandContext } from "./index.ts";
import { CliError, type Ui } from "./ui.ts";

/** Injected collaborators; every field has a production default. */
export interface ApproveDeps extends CommandContext {
  loadProjectConfig: (projectRoot: string) => ProjectConfig;
  resolveImageSelection: typeof resolveImageSelection;
  loadBuildConfig: (configPath: string) => BuildConfig;
  fingerprint: (config: BuildConfig, configDir: string) => BuildFingerprint;
  deriveIdentity: (input: {
    origin: "project" | "system";
    projectRoot: string;
    configPath: string;
  }) => BuildIdentity;
  authorizationFilePath: () => string;
  saveAssociation: (
    filePath: string,
    association: AuthorizationAssociation,
    onWarning?: (message: string) => void,
  ) => void;
}

/** Resolve the production dependencies, applying test overrides last. */
export function resolveApproveDeps(
  ctx: CommandContext,
  overrides: Partial<ApproveDeps> = {},
): ApproveDeps {
  return {
    ...ctx,
    loadProjectConfig,
    resolveImageSelection,
    loadBuildConfig: loadBuildConfigFromDisk,
    fingerprint: computeBuildFingerprint,
    deriveIdentity: deriveBuildIdentity,
    authorizationFilePath,
    saveAssociation,
    ...overrides,
  };
}

function parseApproveArgs(args: readonly string[]): boolean {
  let yes = false;
  for (const arg of args) {
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg.startsWith("-")) throw new CliError(`unknown option "${arg}"`);
    throw new CliError(`unexpected argument "${arg}"`);
  }
  return yes;
}

function requireBuildConfigSelection(
  selection: ImageSelection,
): Extract<ImageSelection, { kind: "buildConfig" }> {
  if (selection.kind === "image") {
    throw new CliError(
      `approve applies to build-config selections only; ` +
        `this project selects an existing guest image ("${selection.value}")`,
    );
  }
  if (selection.kind === "default") {
    throw new CliError(
      "approve applies to build-config selections only; no image source is selected",
    );
  }
  return selection;
}

/**
 * Print the approval summary and record the association on approval.
 * Throws `CliError`, `GuestImageError`, or `CancelledError`.
 */
export async function approveCommand(args: string[], ui: Ui, deps: ApproveDeps): Promise<void> {
  const yes = parseApproveArgs(args);

  const project = deps.loadProjectConfig(deps.cwd);
  const system = deps.system;
  const selection = requireBuildConfigSelection(
    deps.resolveImageSelection(project, system, deps.cwd, deps.env.ECHORIAD_IMAGE),
  );

  const identity = deps.deriveIdentity({
    origin: selection.origin,
    projectRoot: deps.cwd,
    configPath: selection.configPath,
  });
  const config = deps.loadBuildConfig(selection.configPath);

  let fingerprint: BuildFingerprint;
  try {
    fingerprint = deps.fingerprint(config, path.dirname(selection.configPath));
  } catch (error) {
    // Fingerprint errors (missing or unsupported local inputs) are
    // actionable but plain; they must not escape as raw stack traces.
    throw new GuestImageError(error instanceof Error ? error.message : String(error));
  }

  let cached: { buildId: string } | undefined;
  try {
    cached = deps.resolveImage(imageRefForFingerprint(fingerprint.fingerprint));
  } catch {
    cached = undefined;
  }
  if (!cached) {
    throw new CliError(
      `no guest image exists for fingerprint ${fingerprint.abbreviated}; ` +
        `there is nothing to approve yet — ` +
        `run "echoriad build" to build the image and record its approval`,
    );
  }

  // The summary prints on every path — interactive prompt, --yes, and
  // plain mode — so logs always record what was approved.
  const summary = buildApprovalSummary({
    action: "reuse",
    consumer: identity.consumerLabel,
    projectRoot: deps.cwd,
    configPath: selection.configPath,
    localInputPaths: fingerprint.localInputPaths,
    config,
  });
  for (const line of summary.split("\n")) ui.line(line);

  if (!yes) {
    ui.requireInteractive("approve", "use `approve --yes` to record the approval without a prompt");
    const approved = await deps.confirm("approve", "Reuse cached Gondolin guest image?");
    if (!approved) throw new CliError("not approved; no build approval recorded");
  }

  deps.saveAssociation(
    deps.authorizationFilePath(),
    {
      consumer: identity.consumerId,
      config: identity.configId,
      fingerprint: fingerprint.fingerprint,
      buildId: cached.buildId,
    },
    (message) => ui.warn(message),
  );
  ui.line(`approved ${fingerprint.abbreviated} (build ${cached.buildId})`);
}
