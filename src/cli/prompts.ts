/**
 * Interactive decision prompts for CLI commands.
 *
 * Each wrapper takes the command verb first so a prompt cancelled with
 * Ctrl-C becomes `CancelledError`, which main renders through the cancel
 * convention — distinct from a decline. Clack is only ever reached through
 * these wrappers, and commands call `ui.requireInteractive` before
 * prompting, so clack never runs without a terminal.
 */

import { confirm, multiselect, type Option } from "@clack/prompts";
import { CancelledError } from "./ui.ts";

/**
 * One selectable entry of a multiselect prompt. The value is always an
 * object the caller owns; the label is required because clack renders
 * objects through their label.
 */
export interface MultiselectOption<Value extends object> {
  value: Value;
  label: string;
  hint?: string;
}

export interface MultiselectInput<Value extends object> {
  message: string;
  options: MultiselectOption<Value>[];
}

/** A yes/no decision; resolves false on a decline. */
export async function confirmPrompt(command: string, message: string): Promise<boolean> {
  // A cancelled prompt is clack's only symbol result; a typeof check
  // narrows it away where isCancel's unique-symbol predicate cannot.
  const answer = await confirm({ message });
  if (typeof answer === "symbol") throw new CancelledError(command);
  return answer;
}

/** A selection over entries; clack requires at least one choice. */
export async function multiselectPrompt<Value extends object>(
  command: string,
  input: MultiselectInput<Value>,
): Promise<Value[]> {
  const answer = await multiselect<Value>({
    message: input.message,
    // clack's Option<Value> stays a deferred conditional for a type
    // parameter; this shape is exactly its object-valued branch, so the
    // cast is a checked boundary against the library's typing.
    options: input.options as Option<Value>[],
  });
  if (typeof answer === "symbol") throw new CancelledError(command);
  return answer;
}
