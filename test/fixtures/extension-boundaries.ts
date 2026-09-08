import { spawn as spawnChild } from "node:child_process";
import path from "node:path";
export * from "../../node_modules/@earendil-works/gondolin/dist/src/index.js";

export const state = {
  cliPath: "", mode: "failure", imported: false, created: 0, closed: 0,
  lastChildPid: 0,
  outputDirs: [] as string[],
};
export function resolveImageSelector() {
  if (!state.imported) throw new Error("no fixture image");
  return { buildId: "fixture-build-id" };
}
export const VM = {
  async create() {
    state.created++;
    return { id: "fixture-vm", exec: async () => ({ stdout: "/bin/sh" }),
      close: async () => { state.closed++; } };
  },
};
export function spawn(executable: string, args: string[], options: object) {
  state.outputDirs.push(args[args.indexOf("--output") + 1]!);
  const child = spawnChild(executable, [state.cliPath,
    "--config", state.mode], options);
  child.stdout?.on("data", (chunk: Buffer) => {
    const match = /childpid:(\d+)/.exec(String(chunk));
    if (match) state.lastChildPid = Number(match[1]);
  });
  child.on("close", (code) => { if (code === 0) state.imported = true; });
  return child;
}
