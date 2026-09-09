/**
 * The single seam for human-facing CLI output.
 *
 * Every command writes through a `Ui` instance; nothing else in `src/cli/`
 * touches the process streams. The instance decides how output degrades:
 * plain mode drops interactive framing, errors print as `error: <message>`
 * on stderr with exit 1, a cancelled prompt prints `cancelled:
 * <command>`, distinct from a denial, and warnings print as `warning:
 * <message>` on stderr without failing.
 *
 * There is no color in this release: verdict and severity words carry the
 * meaning on their own, so plain mode changes framing only, never content.
 */

/**
 * The stream capability the ui writes through. Narrow on purpose: any
 * writable sink works, and tests capture output without a TTY.
 */
export interface UiStream {
  write(chunk: string): unknown;
}

/**
 * Inputs to plain-mode resolution, in precedence order.
 *
 * `env` follows the NO_COLOR spec: present and non-empty forces plain,
 * regardless of value ("0" and "false" included); an empty string falls
 * through.
 */
export interface PlainModeInput {
  flag: boolean;
  env: string | undefined;
  systemPlain: boolean | undefined;
}

/**
 * Resolve whether output is plain, with precedence
 * `--plain` > `ECHORIAD_PLAIN` > system-config `plain` > off.
 */
export function resolvePlainMode(input: PlainModeInput): boolean {
  if (input.flag) return true;
  if (input.env !== undefined && input.env !== "") return true;
  if (input.systemPlain) return true;
  return false;
}

/** An error whose message is already user-facing; printed after `error: `. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/** The error convention's line format; the ui owns the stream it lands on. */
export function formatError(message: string): string {
  return `error: ${message}\n`;
}

/** The cancel convention's line format. */
export function formatCancel(command: string): string {
  return `cancelled: ${command}\n`;
}

/** The warning convention's line format; warnings are not failures. */
export function formatWarning(message: string): string {
  return `warning: ${message}\n`;
}

/** Signals that the user aborted an interactive prompt (Ctrl+C at clack).
 * The command name lands in the `cancelled: <command>` line, which is a
 * deliberate exit — not a denial of what was asked.
 */
export class CancelledError extends Error {
  readonly command: string;
  constructor(command: string) {
    // The message stays newline-free; formatCancel is the stream form.
    super(`cancelled: ${command}`);
    this.name = "CancelledError";
    this.command = command;
  }
}

export interface Ui {
  /** Whether plain mode is on; commands consult it to skip clack framing. */
  readonly plain: boolean;
  /** Whether both stdin and stdout are a terminal. */
  readonly isInteractive: boolean;
  /** One human-facing line to stdout. */
  line(text: string): void;
  /** The error convention: `error: <message>` on stderr, exit 1. */
  error(message: string): void;
  /** The warning convention: `warning: <message>` on stderr, not a failure. */
  warn(message: string): void;
  /** The cancel convention: `cancelled: <command>` on stderr, exit 1. */
  cancelled(command: string): void;
  /**
   * Fail closed when a prompt-requiring path runs without a terminal.
   * Call before reaching clack; `alternative` points at the flag or
   * noninteractive route that avoids the prompt.
   */
  requireInteractive(command: string, alternative: string): void;
}

export interface UiOptions {
  stdout: UiStream;
  stderr: UiStream;
  plain: boolean;
  isInteractive: boolean;
}

export function createUi(options: UiOptions): Ui {
  return {
    plain: options.plain,
    isInteractive: options.isInteractive,
    line: (text) => {
      options.stdout.write(`${text}\n`);
    },
    error: (message) => {
      options.stderr.write(formatError(message));
    },
    warn: (message) => {
      options.stderr.write(formatWarning(message));
    },
    cancelled: (command) => {
      options.stderr.write(formatCancel(command));
    },
    requireInteractive: (command, alternative) => {
      if (options.isInteractive) return;
      throw new CliError(`${command} needs an interactive terminal to prompt; ${alternative}`);
    },
  };
}
