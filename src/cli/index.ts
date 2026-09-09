/**
 * CLI command dispatch.
 *
 * `main` parses argv by hand (global flags, then the command verb),
 * resolves plain mode, and routes the command with its remaining
 * arguments, the ui, and a command context through the ui and prompt
 * seams. Command handlers are added to COMMANDS as their modules land;
 * a handler receives the ui, its remaining args, and a context carrying
 * the project root, the environment, the loaded system config, the
 * project-config loader, and the interactive seams — it may be async,
 * and `main` awaits it before returning the exit code — and reports
 * failure by throwing `CliError`, `CancelledError`, `ConfigError`,
 * `GuestImageError`, or any interactive cancel. A handler may also
 * return a process exit code; `void` (or nothing) means 0.
 */

import {
  ConfigError,
  loadProjectConfig,
  loadSystemConfig,
  type ProjectConfig,
  type SystemConfig,
} from "../config.ts";
import { GuestImageError, resolveImageBuildId } from "../guest-image.ts";
import { approveCommand, resolveApproveDeps } from "./approve.ts";
import { runBash } from "./bash.ts";
import { buildCommand } from "./build.ts";
import { configCommand } from "./config-command.ts";
import { defaultImagesDeps, type ImagesDeps, runImagesCommand } from "./images.ts";
import { confirmPrompt, type MultiselectInput, multiselectPrompt } from "./prompts.ts";
import { resolveRevokeDeps, revokeCommand } from "./revoke.ts";
import { statusCommand } from "./status.ts";
import {
  CancelledError,
  CliError,
  createUi,
  formatError,
  resolvePlainMode,
  type Ui,
  type UiStream,
} from "./ui.ts";

/** Everything a command handler needs beyond its arguments and the ui. */
export interface CommandContext {
  /** Project root; cwd is the project root for every command. */
  readonly cwd: string;
  /** The environment the command resolves against. */
  readonly env: Record<string, string | undefined>;
  /** The system config `main` already loaded to resolve plain mode. */
  readonly system: SystemConfig;
  /** Project-config loading, injected for tests. */
  readonly loadProjectConfig: (projectRoot: string) => ProjectConfig;
  /** Interactive yes/no decision; Ctrl-C becomes the cancel convention. */
  readonly confirm: (command: string, message: string) => Promise<boolean>;
  /** Interactive selection; Ctrl-C becomes the cancel convention. */
  readonly multiselect: <Value extends object>(
    command: string,
    input: MultiselectInput<Value>,
  ) => Promise<Value[]>;
  /** Resolve a Gondolin image reference to its build ID. */
  readonly resolveImage: (imageRef: string) => { buildId: string };
}

// `void` marks "may return nothing"; `undefined` would force explicit
// returns from every handler.
type CommandHandler = (
  args: string[],
  ui: Ui,
  ctx: CommandContext,
  // biome-ignore lint/suspicious/noConfusingVoidType: intentional void in a return union
) => number | void | Promise<number | void>;

function buildCommands(deps: CliDeps): Record<string, CommandHandler> {
  return {
    status: statusCommand,
    config: configCommand,
    approve: (args, ui, ctx) => approveCommand(args, ui, resolveApproveDeps(ctx)),
    revoke: (args, ui, ctx) => revokeCommand(args, ui, resolveRevokeDeps(ctx)),
    build: (args, ui, ctx) =>
      buildCommand(args, ui, {
        cwd: () => ctx.cwd,
        envImage: () => ctx.env.ECHORIAD_IMAGE,
        loadSystemConfig: () => ctx.system,
      }),
    images: (args, ui, ctx) =>
      runImagesCommand(args, ui, deps.imagesDeps ?? defaultImagesDeps(ctx.cwd)),
    bash: (args, ui, ctx) =>
      runBash(args, ui, {
        projectRoot: ctx.cwd,
        loadProjectConfig: ctx.loadProjectConfig,
        loadSystemConfig: () => ctx.system,
      }),
  };
}

/** Injectable seams for `main`; every field defaults to the real thing. */
export interface CliDeps {
  stdout?: UiStream;
  stderr?: UiStream;
  env?: Record<string, string | undefined>;
  cwd?: string;
  isInteractive?: boolean;
  loadSystemConfig?: () => SystemConfig;
  loadProjectConfig?: (projectRoot: string) => ProjectConfig;
  confirm?: CommandContext["confirm"];
  multiselect?: CommandContext["multiselect"];
  resolveImage?: CommandContext["resolveImage"];
  /** deps for the images command; defaults read live Gondolin state */
  imagesDeps?: ImagesDeps;
}

export async function main(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const isInteractive = deps.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const loadConfig = deps.loadSystemConfig ?? loadSystemConfig;
  const loadProject = deps.loadProjectConfig ?? loadProjectConfig;

  let plainFlag = false;
  let index = 0;
  for (; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--plain") {
      plainFlag = true;
      continue;
    }
    if (arg.startsWith("-")) {
      stderr.write(`error: unknown option "${arg}"\n`);
      return 1;
    }
    break;
  }
  const args = argv.slice(index);
  const command = args[0];

  let ui: Ui;
  let system: SystemConfig;
  try {
    system = loadConfig();
    ui = createUi({
      stdout,
      stderr,
      plain: resolvePlainMode({
        flag: plainFlag,
        env: env.ECHORIAD_PLAIN,
        systemPlain: system.plain,
      }),
      isInteractive,
    });
  } catch (error) {
    // Before the ui exists, the format functions keep the conventions in
    // one place; the streams are the same ones the ui would write to.
    if (error instanceof ConfigError || error instanceof GuestImageError) {
      stderr.write(formatError(error.message));
      return 1;
    }
    throw error;
  }

  const ctx: CommandContext = {
    cwd,
    env,
    system,
    loadProjectConfig: loadProject,
    confirm: deps.confirm ?? confirmPrompt,
    multiselect: deps.multiselect ?? multiselectPrompt,
    resolveImage: deps.resolveImage ?? resolveImageBuildId,
  };

  try {
    if (command === undefined) throw new CliError("missing command");
    const handler = buildCommands(deps)[command];
    if (!handler) throw new CliError(`unknown command "${command}"`);
    const code = await handler(args.slice(1), ui, ctx);
    return typeof code === "number" ? code : 0;
  } catch (error) {
    if (error instanceof CancelledError) {
      ui.cancelled(error.command);
      return 1;
    }
    if (
      error instanceof CliError ||
      error instanceof ConfigError ||
      error instanceof GuestImageError
    ) {
      ui.error(error.message);
      return 1;
    }
    throw error;
  }
}
