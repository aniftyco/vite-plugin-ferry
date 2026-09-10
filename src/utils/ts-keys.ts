/** A property name that needs no quoting: a valid JS/TS identifier. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Render a property name for an object-type literal: a bare key when it is a valid JS
 * identifier, otherwise a JSON-quoted string-literal key (`'display-name'` → `"display-name"`).
 * Keeps generated `.d.ts` valid for keys carrying hyphens, dots, spaces, or other characters
 * a bare identifier can't hold. Shared by the page and resource generators so both escape
 * keys the same way.
 */
export function renderKey(key: string): string {
  return IDENTIFIER.test(key) ? key : JSON.stringify(key);
}
