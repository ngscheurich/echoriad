/**
 * CLI command dispatch.
 *
 * `main` parses argv by hand (global flags, then the command verb),
 * resolves plain mode, and routes through the ui seam. Command handlers
 * are added to COMMANDS as their modules land; a handler receives the
 * ui, its remaining args, and a context carrying the project root, the
 * environment, the loaded system config, and the project-config loader
 * — it may be async, and `main` awaits it before returning the exit
 * code — and reports failure by throwing `CliError`, `CancelledError`,
 * `ConfigError`, or `GuestImageError`.
 */

import {
  ConfigError,
  loadProjectConfig,
  loadSystemConfig,
  type ProjectConfig,
  type SystemConfig,
} from "../config.ts";
import { GuestImageError } from "../guest-image.ts";
import { buildCommand } from "./build.ts";
import { configCommand } from "./config-command.ts";
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

/** The execution context every command handler receives. */
export interface CommandContext {
  /** the project root: cwd is the project root for every command */
  readonly cwd: string;
  /** the environment image selection and plain mode read from */
  readonly env: Record<string, string | undefined>;
  /** the system config `main` already loaded to resolve plain mode */
  readonly system: SystemConfig;
  /** project-config loading, injected for tests */
  readonly loadProjectConfig: (projectRoot: string) => ProjectConfig;
}

type CommandHandler = (
  args: string[],
  ui: Ui,
  ctx: CommandContext,
) => void | Promise<void>;

const COMMANDS: Record<string, CommandHandler> = {
  status: statusCommand,
  config: configCommand,
  build: (args, ui, ctx) =>
    buildCommand(args, ui, {
      cwd: () => ctx.cwd,
      envImage: () => ctx.env.ECHORIAD_IMAGE,
      loadSystemConfig: () => ctx.system,
    }),
};

/** Injectable seams for `main`; every field defaults to the real thing. */
export interface CliDeps {
  stdout?: UiStream;
  stderr?: UiStream;
  env?: Record<string, string | undefined>;
  cwd?: string;
  isInteractive?: boolean;
  loadSystemConfig?: () => SystemConfig;
  loadProjectConfig?: (projectRoot: string) => ProjectConfig;
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

  try {
    if (command === undefined) throw new CliError("missing command");
    const handler = COMMANDS[command];
    if (!handler) throw new CliError(`unknown command "${command}"`);
    await handler(args.slice(1), ui, {
      cwd,
      env,
      system,
      loadProjectConfig: loadProject,
    });
    return 0;
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
