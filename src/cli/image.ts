/**
 * Guest image source resolution for CLI commands.
 *
 * Mirrors the pi extension's startup resolution over the same shared core:
 * the selected source decides between Gondolin's default image, an
 * existing image selector or asset directory (resolved through
 * `resolveImageTarget`), and a build config that runs the shared approval,
 * fingerprint, and build pipeline. The CLI's approval prompt is clack
 * `confirm` over the standard summary; a denied prompt stops resolution
 * and a cancelled prompt reports `cancelled: <command>`. Gondolin's build
 * output streams as discrete lines so no path repaints in place.
 */

import { confirm, isCancel } from "@clack/prompts";
import { resolveImageSelection, resolveImageTarget } from "../config.ts";
import {
  type ApprovalAction,
  type GuestImageDeps,
  type GuestImageResult,
  prepareGuestImage,
} from "../guest-image.ts";
import { deriveBuildIdentity } from "../identity.ts";
import type { LoadedConfigs } from "../vm-spec.ts";
import { CancelledError, type Ui } from "./ui.ts";

export interface ResolveGuestImageDeps {
  /** approval prompt; defaults to clack confirm over the standard summary */
  approve?: (action: ApprovalAction, summary: string) => Promise<boolean>;
  /** forwarded to the shared build pipeline; test seam */
  prepare?: Partial<GuestImageDeps>;
}

export interface ResolveGuestImageInput {
  projectRoot: string;
  configs: LoadedConfigs;
  ui: Ui;
  /** the invoking command; cancelled approvals report under its name */
  command: string;
  deps?: ResolveGuestImageDeps;
}

export interface ResolvedGuestImage {
  /** image path or selector for the VM spec; undefined = Gondolin default */
  imagePath?: string;
  /** present only when a build config was selected and prepared */
  build?: GuestImageResult;
}

/**
 * The clack-backed approval prompt: the standard summary under the same
 * titles the extension uses. A Ctrl+C at the prompt is a cancellation,
 * not a denial.
 */
function clackApprove(
  command: string,
): (action: ApprovalAction, summary: string) => Promise<boolean> {
  return async (action, summary) => {
    const title =
      action === "build" ? "Build Gondolin guest image?" : "Reuse cached Gondolin guest image?";
    const answer = await confirm({ message: `${title}\n\n${summary}` });
    if (isCancel(answer)) throw new CancelledError(command);
    return answer === true;
  };
}

/**
 * Resolve the guest image source for a CLI invocation. A build-config
 * selection runs the shared pipeline with the CLI's approval prompt; the
 * interactive flag follows the ui so a non-TTY invocation fails closed
 * inside the pipeline before anything is built.
 */
export async function resolveGuestImage(
  input: ResolveGuestImageInput,
): Promise<ResolvedGuestImage> {
  const selection = resolveImageSelection(
    input.configs.project,
    input.configs.system,
    input.projectRoot,
  );

  if (selection.kind === "default") {
    return {};
  }

  if (selection.kind === "image") {
    return { imagePath: resolveImageTarget(selection) };
  }

  // A build config is selected: derive the consumer identity exactly as
  // the extension does, so approval in one surface authorizes the other.
  const identity = deriveBuildIdentity({
    origin: selection.origin,
    projectRoot: input.projectRoot,
    configPath: selection.configPath,
  });

  // Gondolin's build output arrives in arbitrary chunks; emit discrete
  // lines only, and only complete ones.
  let pending = "";
  const emitBuildOutput = (chunk: string): void => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline === -1) break;
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (line.trim() !== "") input.ui.line(line);
    }
  };

  const result = await prepareGuestImage({
    configPath: selection.configPath,
    projectRoot: input.projectRoot,
    consumer: identity.consumerLabel,
    consumerId: identity.consumerId,
    configId: identity.configId,
    interactive: input.ui.isInteractive,
    approve: input.deps?.approve ?? clackApprove(input.command),
    onStatus: (message) => input.ui.line(`Echoriad: ${message}`),
    onWarning: (message) => input.ui.line(message),
    onBuildOutput: emitBuildOutput,
    onBuildFailure: (outputTail) =>
      input.ui.error(`Echoriad: guest image build failed.\nRecent Gondolin output:\n${outputTail}`),
    deps: input.deps?.prepare,
  });
  return { imagePath: result.imageSelector, build: result };
}
