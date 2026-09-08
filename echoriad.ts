#!/usr/bin/env node
/**
 * CLI bin entrypoint.
 *
 * The implementation lives in `src/cli/`; this file only keeps the
 * `echoriad` bin entry working, mirroring the pi extension's root
 * entrypoint. The exit code comes back from `main` so process state is
 * touched exactly once, here.
 */

import { main } from "./src/cli/index.ts";

process.exitCode = main(process.argv.slice(2));
