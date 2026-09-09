/**
 * `echoriad bash`: an interactive guest shell in a fresh VM configured
 * for the project at cwd.
 *
 * The VM is built programmatically from the shared spec module — image
 * from the shared guest-image pipeline, cpus/memory/mounts/network/secrets
 * from the resolved configuration — never by spawning `gondolin bash`,
 * whose flag surface has no --cpus/--memory and would silently drop the
 * project's scalar configuration. A fresh VM is created per invocation
 * and torn down on exit; the guest shell's exit code passes through.
 *
 * The host terminal is attached to the guest shell with raw mode, resize
 * forwarding, and a Ctrl-] detach escape (exit 130). Gondolin's own
 * `attachTty` helper is not exported from the package, so the attach is
 * reimplemented here over the public `vm.shell({ attach: false })`
 * process surface.
 */

import path from "node:path";
import { type ExecProcess, VM, type VMOptions } from "@earendil-works/gondolin";
import {
  loadProjectConfig,
  loadSystemConfig,
  type ProjectConfig,
  type SystemConfig,
} from "../config.ts";
import { GUEST_WORKSPACE, resolveVmSpec } from "../vm-spec.ts";
import {
  type ResolvedGuestImage,
  type ResolveGuestImageInput,
  resolveGuestImage,
} from "./image.ts";
import { CliError, type Ui } from "./ui.ts";

/** bash -> sh fallback, mirroring Gondolin's own interactive default. */
const INTERACTIVE_SHELL_COMMAND = [
  "/bin/sh",
  "-lc",
  "if command -v bash >/dev/null 2>&1; then exec bash -i; else exec /bin/sh -i; fi",
];

/** The detach escape byte: Ctrl-]. */
const DETACH_BYTE = 0x1d;

/** Injectable seams for the bash command; every field defaults to the real thing. */
export interface BashDeps {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  createVm?: (options: VMOptions) => Promise<VM>;
  resolveImage?: (input: ResolveGuestImageInput) => Promise<ResolvedGuestImage>;
  /** the project root to resolve configs against; defaults to process cwd */
  projectRoot?: string;
  loadProjectConfig?: (projectRoot: string) => ProjectConfig;
  loadSystemConfig?: () => SystemConfig;
}

export interface TtyAttach {
  /** settles when the user pressed the detach escape (Ctrl-]) */
  escape: Promise<void>;
  /** undoes raw mode and listeners; safe to call more than once */
  cleanup: () => void;
}

/**
 * Attach the host terminal to a guest shell process: raw input with a
 * Ctrl-] detach escape, guest output piped to stdout and stderr, and
 * terminal resizes forwarded to the guest pty. Output pipes keep the
 * guest's flow control intact (`pipe`, never unbounded buffering), and
 * detaching stops forwarding in both directions immediately.
 */
export function attachTty(
  proc: ExecProcess,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
): TtyAttach {
  let resolveEscape: () => void = () => {};
  const escapePromise = new Promise<void>((resolve) => {
    resolveEscape = resolve;
  });
  let cleaned = false;

  const onResize = (): void => {
    if (typeof stdout.columns === "number" && typeof stdout.rows === "number") {
      proc.resize(stdout.rows, stdout.columns);
    }
  };
  const detachOutput = (): void => {
    proc.stdout?.unpipe(stdout);
    proc.stdout?.pause();
    proc.stderr?.unpipe(stderr);
    proc.stderr?.pause();
  };
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    stdin.off("data", onStdinData);
    stdin.off("end", onStdinEnd);
    if (stdout.isTTY) stdout.off("resize", onResize);
    if (stdin.isTTY) {
      try {
        stdin.setRawMode(false);
      } catch {
        // The stream may already be destroyed; there is nothing to restore.
      }
    }
    stdin.pause();
  };
  const onStdinData = (chunk: Buffer): void => {
    const detach = chunk.indexOf(DETACH_BYTE);
    if (detach !== -1) {
      // Forward what arrived before the escape, then stop both
      // directions; the escape byte itself never reaches the guest.
      if (detach > 0) proc.write(chunk.subarray(0, detach));
      detachOutput();
      cleanup();
      resolveEscape();
      return;
    }
    proc.write(chunk);
  };
  const onStdinEnd = (): void => {
    proc.end();
  };

  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  if (stdout.isTTY) {
    onResize();
    stdout.on("resize", onResize);
  }
  stdin.on("data", onStdinData);
  stdin.on("end", onStdinEnd);
  // pipe keeps the guest's credit window intact: backpressure on the host
  // side pauses the source instead of buffering without bound.
  proc.stdout?.pipe(stdout, { end: false });
  proc.stderr?.pipe(stderr, { end: false });
  // The attach must come down with the session even if no one races the
  // escape; both settlements mean the shell is done.
  void proc.result.then(
    () => cleanup(),
    () => cleanup(),
  );

  return { escape: escapePromise, cleanup };
}

/**
 * Run `echoriad bash`: resolve the project configuration and guest image,
 * create a fresh VM from the shared spec, and attach the terminal to an
 * interactive shell in the guest workspace. Returns the guest shell's
 * exit code; the Ctrl-] detach escape returns 130, matching the
 * conventional terminated-by-user code.
 */
export async function runBash(
  args: readonly string[],
  ui: Ui,
  deps: BashDeps = {},
): Promise<number> {
  if (args.length > 0) {
    throw new CliError(`bash takes no arguments (got "${args[0]}")`);
  }
  if (!ui.isInteractive) {
    throw new CliError(
      "echoriad bash needs an interactive terminal to attach the guest shell; " +
        "start it from an attached terminal",
    );
  }

  const projectRoot = deps.projectRoot ?? process.cwd();
  const configs = {
    project: (deps.loadProjectConfig ?? loadProjectConfig)(projectRoot),
    system: (deps.loadSystemConfig ?? loadSystemConfig)(),
  };
  const image = await (deps.resolveImage ?? resolveGuestImage)({
    projectRoot,
    configs,
    ui,
    command: "echoriad bash",
  });
  const spec = resolveVmSpec({
    projectRoot,
    configs,
    imagePath: image.imagePath,
    sessionLabel: `echoriad bash ${path.basename(projectRoot)}`,
  });
  const vm = await (deps.createVm ?? VM.create)(spec.options);
  try {
    const proc = vm.shell({
      attach: false,
      cwd: GUEST_WORKSPACE,
      command: INTERACTIVE_SHELL_COMMAND,
    });
    const attach = attachTty(
      proc,
      deps.stdin ?? process.stdin,
      deps.stdout ?? process.stdout,
      deps.stderr ?? process.stderr,
    );
    const raced = await Promise.race([
      proc.result.then(
        (result) => ({ kind: "result" as const, result }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      attach.escape.then(() => ({ kind: "escape" as const })),
    ]);
    attach.cleanup();
    if (raced.kind === "escape") {
      ui.line("[echoriad] detached (Ctrl-])");
      return 130;
    }
    if (raced.kind === "error") throw raced.error;
    if (raced.result.signal !== undefined) {
      ui.line(`guest shell exited due to signal ${raced.result.signal}`);
    }
    return raced.result.exitCode;
  } finally {
    try {
      await vm.close();
    } catch {
      // Teardown is best effort; the session result is already decided.
    }
  }
}
