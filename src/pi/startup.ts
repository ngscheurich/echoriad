/**
 * Startup image-source resolution for the pi extension.
 *
 * Resolves the selected guest image source for one startup and, when a
 * build config is selected, runs the human approval prompt, fingerprinting,
 * and automatic build through the shared guest-image pipeline. The pi UI
 * carries the prompts, status lines, and build output streaming; the
 * pipeline itself lives in `guest-image.ts`.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveImageSelection } from "../config.ts";
import { prepareGuestImage } from "../guest-image.ts";
import { deriveBuildIdentity } from "../identity.ts";
import type { LoadedConfigs } from "../vm-spec.ts";

/** Automatic-build details `/echoriad` reports for a build-config startup. */
export type AutomaticBuildReport = {
  configPath: string;
  abbreviatedFingerprint: string;
  buildId: string;
  built: boolean;
};

export type ResolvedImageStartup = {
  imagePath?: string;
  imageLabel: string;
  /** present only when startup selected a build config, not a direct image */
  build?: AutomaticBuildReport;
};

/**
 * Resolve the guest image source for this startup. When a build config is
 * selected, the human approval prompt, fingerprinting, and automatic build
 * happen here; the returned image selector is the imported Gondolin build ID.
 */
export async function resolveImageStartup(
  projectRoot: string,
  configs: LoadedConfigs,
  ctx?: ExtensionContext,
  signal?: AbortSignal,
): Promise<ResolvedImageStartup> {
  const selection = resolveImageSelection(configs.project, configs.system, projectRoot);

  if (selection.kind === "default") {
    return { imageLabel: "default" };
  }

  if (selection.kind === "image") {
    // Precedence: project config > system config > env var. Like Gondolin's
    // own resolvePathSelector(), an image value that resolves against the
    // declaring directory to an existing directory is a path; anything else
    // passes through as a "name:tag"-style selector. There is no dot-prefix
    // requirement, so a system config can declare "image": "images/base".
    const image = selection.value;
    const resolved = path.resolve(selection.baseDir, image);
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(resolved).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (isDirectory) return { imagePath: resolved, imageLabel: image };
    return { imagePath: image, imageLabel: image };
  }

  // A build config is selected: fingerprint it, then reuse an authorized
  // cached image silently or require approval before reusing or building.
  // The consumer identity is the canonical common Git directory for Git
  // projects (linked worktrees share it), the canonical project root
  // otherwise, and a system-wide consumer for system-selected configs.
  const identity = deriveBuildIdentity({
    origin: selection.origin,
    projectRoot,
    configPath: selection.configPath,
  });
  const result = await prepareGuestImage({
    configPath: selection.configPath,
    projectRoot,
    consumer: identity.consumerLabel,
    consumerId: identity.consumerId,
    configId: identity.configId,
    interactive: Boolean(ctx?.hasUI),
    signal,
    approve: (action, summary) =>
      ctx
        ? ctx.ui.confirm(
            action === "build"
              ? "Build Gondolin guest image?"
              : "Reuse cached Gondolin guest image?",
            summary,
            { signal },
          )
        : Promise.resolve(false),
    onWarning: (message) => {
      // Messages from the authorization store are already prefixed.
      ctx?.ui.notify(message, "warning");
    },
    onStatus: (message) => ctx?.ui.setStatus("echoriad", `Echoriad: ${message}`),
    onBuildOutput: (chunk) => {
      // Stream Gondolin's output to the human-facing status line only;
      // it never enters model context. The latest line replaces the
      // previous one instead of stacking a notification per chunk.
      const lastLine =
        chunk
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .pop() ?? "";
      if (ctx?.hasUI) {
        ctx.ui.setStatus("echoriad", `Echoriad: building guest image — ${lastLine.slice(0, 80)}`);
      } else {
        process.stderr.write(chunk);
      }
    },
    onBuildFailure: (outputTail) => {
      ctx?.ui.notify(
        `Echoriad: guest image build failed.\nRecent Gondolin output:\n${outputTail}`,
        "error",
      );
    },
  });
  return {
    imagePath: result.imageSelector,
    imageLabel: result.imageRef,
    build: {
      configPath: result.configPath,
      abbreviatedFingerprint: result.abbreviatedFingerprint,
      buildId: result.buildId,
      built: result.built,
    },
  };
}
