const mode = process.argv[process.argv.indexOf("--config") + 1];
console.log("stdout fixture");
console.error("stderr fixture");
if (mode === "failure") process.exitCode = 3;
if (mode === "tree") {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", `
    process.on("SIGTERM", () => {});
    console.log("descendant:" + process.pid);
    setTimeout(() => process.exit(), 4000);
  `], { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.pipe(process.stdout);
  process.on("SIGTERM", () => process.exit());
}
if (mode === "environment") console.log("inherited:" + process.env.ECHORIAD_BUILD_FIXTURE);
if (mode === "hang") {
  console.log("childpid:" + process.pid);
  process.on("SIGTERM", () => {});
  setTimeout(() => process.exit(7), 3000);
}
