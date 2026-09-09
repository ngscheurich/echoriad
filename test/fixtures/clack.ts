/**
 * A @clack/prompts fixture: `confirm` answers from mutable state so tests
 * drive the approval prompt without a terminal, and records every message
 * it was shown.
 */
const cancelSymbol = Symbol("clack:cancel");

export const CANCEL_SYMBOL = cancelSymbol;

export const state = {
  /** what the next confirm returns: true, false, or the cancel symbol */
  answer: true as boolean | typeof cancelSymbol,
  /** the cancel symbol, reachable through state for one-line assignment */
  cancel: cancelSymbol as typeof cancelSymbol,
  /** every confirm message, in order */
  messages: [] as string[],
};

export async function confirm(options: {
  message: string;
}): Promise<boolean | typeof cancelSymbol> {
  state.messages.push(options.message);
  return state.answer;
}

export function isCancel(value: unknown): value is typeof cancelSymbol {
  return value === cancelSymbol;
}
