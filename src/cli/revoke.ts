/**
 * `echoriad revoke` — delete build approvals without launching a VM or pi.
 *
 * Revocation lists the current consumer's associations for the project at
 * cwd (several fingerprints may accumulate) and deletes the chosen ones
 * from the authorization metadata — nothing else. The cached guest image is
 * never deleted (`images remove` owns that), and other consumers'
 * associations are out of scope. `--all` selects everything; `--yes` skips
 * the confirmation, so `revoke --all --yes` is the noninteractive route.
 */

import {
  type AuthorizationAssociation,
  authorizationFilePath,
  readAuthorizations,
  saveAssociations,
} from "../authorization.ts";
import { loadProjectConfig, type ProjectConfig, resolveImageSelection } from "../config.ts";
import {
  type BuildIdentity,
  type ConsumerIdentity,
  deriveBuildIdentity,
  deriveConsumerIdentity,
} from "../identity.ts";
import type { CommandContext } from "./index.ts";
import type { MultiselectInput } from "./prompts.ts";
import { CliError, type Ui } from "./ui.ts";

/** Injected collaborators; every field has a production default. */
export interface RevokeDeps extends CommandContext {
  loadProjectConfig: (projectRoot: string) => ProjectConfig;
  resolveImageSelection: typeof resolveImageSelection;
  deriveIdentity: (input: {
    origin: "project" | "system";
    projectRoot: string;
    configPath: string;
  }) => BuildIdentity;
  deriveConsumerIdentity: (projectRoot: string) => ConsumerIdentity;
  authorizationFilePath: () => string;
  readAuthorizations: (
    filePath: string,
    onWarning?: (message: string) => void,
  ) => AuthorizationAssociation[];
  saveAssociations: (filePath: string, associations: AuthorizationAssociation[]) => void;
}

/** Resolve the production dependencies, applying test overrides last. */
export function resolveRevokeDeps(
  ctx: CommandContext,
  overrides: Partial<RevokeDeps> = {},
): RevokeDeps {
  return {
    ...ctx,
    loadProjectConfig,
    resolveImageSelection,
    deriveIdentity: deriveBuildIdentity,
    deriveConsumerIdentity,
    authorizationFilePath,
    readAuthorizations,
    saveAssociations,
    ...overrides,
  };
}

function parseRevokeArgs(args: readonly string[]): { all: boolean; yes: boolean } {
  let all = false;
  let yes = false;
  for (const arg of args) {
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg.startsWith("-")) throw new CliError(`unknown option "${arg}"`);
    throw new CliError(`unexpected argument "${arg}"`);
  }
  return { all, yes };
}

function sameAssociation(a: AuthorizationAssociation, b: AuthorizationAssociation): boolean {
  return (
    a.consumer === b.consumer &&
    a.config === b.config &&
    a.fingerprint === b.fingerprint &&
    a.buildId === b.buildId
  );
}

/**
 * The consumer whose associations this project may revoke: derived from
 * the selected build config when one is selected (system-wide scope for a
 * system selection), and from the project root otherwise, so approvals
 * accumulated under an earlier build-config selection stay revocable.
 */
function currentConsumerId(deps: RevokeDeps): string {
  const project = deps.loadProjectConfig(deps.cwd);
  const system = deps.system;
  const selection = deps.resolveImageSelection(project, system, deps.cwd, deps.env.ECHORIAD_IMAGE);
  if (selection.kind === "buildConfig") {
    return deps.deriveIdentity({
      origin: selection.origin,
      projectRoot: deps.cwd,
      configPath: selection.configPath,
    }).consumerId;
  }
  return deps.deriveConsumerIdentity(deps.cwd).consumerId;
}

/**
 * Print the current consumer's associations, remove the chosen ones, and
 * report each revocation. Throws `CliError` or `CancelledError`.
 */
export async function revokeCommand(args: string[], ui: Ui, deps: RevokeDeps): Promise<void> {
  const { all, yes } = parseRevokeArgs(args);

  const consumerId = currentConsumerId(deps);
  const file = deps.authorizationFilePath();
  const associations = deps.readAuthorizations(file, (message) => ui.warn(message));
  const own = associations.filter((entry) => entry.consumer === consumerId);

  if (own.length === 0) {
    ui.line("no build approvals to revoke");
    return;
  }

  let selected: AuthorizationAssociation[];
  if (all) {
    selected = own;
  } else {
    ui.requireInteractive(
      "revoke",
      "use `revoke --all --yes` to revoke every association without prompts",
    );
    const input: MultiselectInput<AuthorizationAssociation> = {
      message: "Select build approvals to revoke:",
      options: own.map((entry) => ({
        value: entry,
        label: `${entry.config} (fingerprint ${entry.fingerprint.slice(0, 12)})`,
        hint: `build ${entry.buildId}`,
      })),
    };
    selected = await deps.multiselect("revoke", input);
  }

  if (selected.length === 0) {
    ui.line("no associations selected; nothing revoked");
    return;
  }

  if (!yes) {
    ui.requireInteractive("revoke", "use `revoke --yes` to skip the confirmation");
    const message =
      selected.length === 1
        ? "Revoke 1 build approval?"
        : `Revoke ${selected.length} build approvals?`;
    const confirmed = await deps.confirm("revoke", message);
    if (!confirmed) throw new CliError("not revoked; no associations removed");
  }

  // Keep every association except the selected ones: other consumers' and
  // the current consumer's unselected entries both survive, and the
  // cached image is never touched by revocation.
  const kept = associations.filter(
    (entry) => !selected.some((chosen) => sameAssociation(chosen, entry)),
  );
  deps.saveAssociations(file, kept);
  for (const entry of selected) {
    ui.line(`revoked ${entry.fingerprint.slice(0, 12)} (${entry.config})`);
  }
}
