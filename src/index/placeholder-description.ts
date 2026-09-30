/**
 * The description `palm create` writes when none is given (ruling M21): one line that starts
 * with `TODO: describe`, so harness listings show it is unfinished and `palm check` can warn
 * until someone writes the real one.
 */

/** The marker a placeholder description starts with. */
export const PLACEHOLDER_MARK = 'TODO: describe';

/** True for a description `palm create` wrote as a placeholder (`TODO: describe …`). */
export function isPlaceholderDescription(text: string | undefined): boolean {
  return text?.trimStart().startsWith(PLACEHOLDER_MARK) ?? false;
}
