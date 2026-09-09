/**
 * `echoriad build` — bring the project's guest image up to date.
 *
 * Runs the same fingerprint, approval, and build pipeline as the pi
 * extension for the project at cwd, so an approval recorded here enables
 * silent reuse there and vice versa. A cached image the consumer is
 * authorized for prints `up to date` and exits 0; anything else renders
 * the approval summary and prompts, then streams Gondolin's build output
 * as discrete lines — clack's taskLog framing on an interactive terminal,
 * bare lines otherwise, so piped output is never repainted in place.
 */

import { confirm, intro, isCancel, note, outro, taskLog } from "@clack/prompts";
import type { SystemConfig } from "../config.ts";
import { loadProjectConfig, loadSystemConfig, resolveImageSelection } from "../config.ts";
import type { ApprovalAction, GuestImageResult, PrepareGuestImageOptions } from "../guest-image.ts";
import { prepareGuestImage } from "../guest-image.ts";
import { deriveBuildIdentity } from "../identity.ts";
import { CancelledError, CliError, type Ui } from "./ui.ts";

/** Injectable seams for `buildCommand`; every field defaults to the real thing. */
export interface BuildDeps {
  cwd: () => string;
  envImage: () => string | undefined;
  loadSystemConfig: () => SystemConfig;
  prepareGuestImage: (options: PrepareGuestImageOptions) => Promise<GuestImageResult>;
  prompt: (action: ApprovalAction, summary: string) => Promise<boolean>;
}

type TaskLog = ReturnType<typeof taskLog>;

/**
 * Put the approval summary in front of the human: the clack note frame on
 * an interactive terminal in full-output mode, the summary text verbatim
 * on the plain seam otherwise.
 */
export function renderApprovalSummary(ui: Ui, summary: string): void {
  if (ui.isInteractive && !ui.plain) {
    note(summary);
    return;
  }
  ui.line(summary);
}

/** The clack-backed approval prompt; a cancel is an abort, not a denial. */
function defaultPrompt(ui: Ui): BuildDeps["prompt"] {
  return async (action, summary) => {
    renderApprovalSummary(ui, summary);
    const answer = await confirm({
      message:
        action === "build" ? "Build Gondolin guest image?" : "Reuse cached Gondolin guest image?",
    });
    if (isCancel(answer)) throw new CancelledError("build");
    return answer === true;
  };
}

export async function buildCommand(
  args: string[],
  ui: Ui,
  injected: Partial<BuildDeps> = {},
): Promise<void> {
  let force = false;
  for (const arg of args) {
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg.startsWith("-")) throw new CliError(`unknown option "${arg}"`);
    throw new CliError(`unexpected argument "${arg}"`);
  }

  const deps: BuildDeps = {
    cwd: () => process.cwd(),
    envImage: () => process.env.ECHORIAD_IMAGE,
    loadSystemConfig,
    prepareGuestImage,
    prompt: defaultPrompt(ui),
    ...injected,
  };

  const projectRoot = deps.cwd();
  const project = loadProjectConfig(projectRoot);
  const system = deps.loadSystemConfig();
  const selection = resolveImageSelection(project, system, projectRoot, deps.envImage());

  if (selection.kind !== "buildConfig") {
    const selected =
      selection.kind === "image" ? `the existing image "${selection.value}"` : "the default image";
    throw new CliError(
      `build applies to build-config selections only, but this project selects ${selected}`,
    );
  }

  const identity = deriveBuildIdentity({
    origin: selection.origin,
    projectRoot,
    configPath: selection.configPath,
  });

  const framed = ui.isInteractive && !ui.plain;
  if (framed) intro("echoriad build");

  let task: TaskLog | undefined;
  let pending = "";
  const emitLine = (line: string) => {
    const text = line.replace(/\r$/, "").trim();
    if (text === "") return;
    if (framed) {
      task ??= taskLog({ title: "building guest image", limit: 50 });
      task.message(text);
      return;
    }
    ui.line(text);
  };
  const onBuildOutput = (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) emitLine(line);
  };

  let prompted = false;
  let result: GuestImageResult;
  try {
    result = await deps.prepareGuestImage({
      configPath: selection.configPath,
      projectRoot,
      consumer: identity.consumerLabel,
      consumerId: identity.consumerId,
      configId: identity.configId,
      interactive: ui.isInteractive,
      force,
      approve: async (action, summary) => {
        prompted = true;
        return deps.prompt(action, summary);
      },
      onWarning: (message) => ui.line(message),
      onBuildOutput,
    });
  } finally {
    emitLine(pending);
  }

  // `approve` runs exactly when the pipeline needed a decision, so an
  // unprompted success is the authorized silent cache reuse.
  const completion = !prompted
    ? "up to date"
    : result.built
      ? `guest image build complete ${result.abbreviatedFingerprint}`
      : `reused cached guest image ${result.abbreviatedFingerprint}`;

  if (framed) {
    if (task) {
      task.success(completion);
      outro();
    } else {
      outro(completion);
    }
  } else {
    ui.line(completion);
  }
}
