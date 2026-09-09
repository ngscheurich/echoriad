/**
 * `echoriad config` — the origin-annotated resolved configuration view.
 *
 * Prints the effective configuration for the project at cwd: the resolved
 * image selection (kind, canonical path, origin) and every scalar field
 * with the layer it coalesced from — project, system, env, or built-in
 * default. `--json` emits the same view as one machine-readable object,
 * so the scripting surface carries everything the human form does. An
 * invalid configuration file is an error, never a silently degraded
 * "resolved" view.
 */

import { type ImageSelection, resolveImageSelection } from "../config.ts";
import type { CommandContext } from "./index.ts";
import { CliError, type Ui } from "./ui.ts";

/** One coalesced field: the winning value and the layer it came from. */
interface FieldOrigin {
  value: unknown;
  origin: string;
}

/**
 * Scalar coalescing per the spec: `project.x ?? system.x`, no env fallback
 * for scalars today. A field set in neither layer reads as the built-in
 * default.
 */
function coalesceField(projectValue: unknown, systemValue: unknown): FieldOrigin {
  if (projectValue !== undefined) return { value: projectValue, origin: "project" };
  if (systemValue !== undefined) return { value: systemValue, origin: "system" };
  return { value: null, origin: "built-in default" };
}

/** The image selection as one JSON object: kind, kind-specific detail, origin. */
function imageJson(selection: ImageSelection): Record<string, unknown> {
  switch (selection.kind) {
    case "buildConfig":
      return {
        kind: "buildConfig",
        configPath: selection.configPath,
        origin: selection.origin,
      };
    case "image":
      return {
        kind: "image",
        value: selection.value,
        baseDir: selection.baseDir,
        origin: selection.origin,
      };
    case "default":
      return { kind: "default", origin: selection.origin };
  }
}

/** The image selection in words: its kind and canonical path or selector. */
function imageText(selection: ImageSelection): string {
  switch (selection.kind) {
    case "buildConfig":
      return `buildConfig ${selection.configPath}`;
    case "image":
      return `image ${selection.value} (base dir ${selection.baseDir})`;
    case "default":
      return "default";
  }
}

/** A scalar value in words; objects render as inline JSON. */
function valueText(value: unknown): string {
  if (value === null) return "not set";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function configCommand(args: string[], ui: Ui, ctx: CommandContext): void {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("-")) throw new CliError(`unknown option "${arg}"`);
    throw new CliError(`config takes no arguments, but got "${arg}"`);
  }

  const project = ctx.loadProjectConfig(ctx.cwd);
  const selection = resolveImageSelection(project, ctx.system, ctx.cwd, ctx.env.ECHORIAD_IMAGE);

  const cpus = coalesceField(project.cpus, ctx.system.cpus);
  const memory = coalesceField(project.memory, ctx.system.memory);
  const network = coalesceField(project.network, ctx.system.network);
  const mounts = coalesceField(project.mounts, ctx.system.mounts);

  if (json) {
    ui.line(
      JSON.stringify(
        {
          image: imageJson(selection),
          cpus,
          memory,
          network,
          mounts,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Meaning rides on words, one field per line; aligned columns are
  // announced as noise by a screen reader reading left to right.
  ui.line(`image: ${imageText(selection)} (${selection.origin})`);
  ui.line(`cpus: ${valueText(cpus.value)} (${cpus.origin})`);
  ui.line(`memory: ${valueText(memory.value)} (${memory.origin})`);
  ui.line(`network: ${valueText(network.value)} (${network.origin})`);
  ui.line(`mounts: ${valueText(mounts.value)} (${mounts.origin})`);
}
