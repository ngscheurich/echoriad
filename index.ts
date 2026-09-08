/**
 * Pi extension entrypoint.
 *
 * The implementation lives in `src/pi/`; this file only keeps the pi
 * manifest path (`pi.extensions: ["./index.ts"]`) working. The `echoriad`
 * CLI (see `src/cli/`) shares the same core under `src/`.
 */

export { default } from "./src/pi/index.ts";
