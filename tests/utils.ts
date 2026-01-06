/**
 * Strips leading whitespace from a multi-line string based on the minimum indentation.
 * Useful for writing expected output inline with readable indentation.
 *
 * Usage: dedent`your indented string here`
 */
export function dedent(strings: TemplateStringsArray, ...values: unknown[]): string {
  // Reconstruct the string from template parts
  let str = strings[0];
  for (let i = 0; i < values.length; i++) {
    str += String(values[i]) + strings[i + 1];
  }

  // Remove leading newline if present
  let lines = str.replace(/^\n/, '').split('\n');

  // Remove trailing indentation line (non-empty whitespace before closing backtick)
  // But preserve intentionally empty lines (length === 0)
  const lastLine = lines[lines.length - 1];
  if (lines.length > 0 && lastLine.length > 0 && lastLine.trim() === '') {
    lines = lines.slice(0, -1);
  }

  // Find minimum indentation (ignoring empty lines)
  const minIndent = lines
    .filter((line) => line.trim().length > 0)
    .reduce((min, line) => {
      const match = line.match(/^(\s*)/);
      const indent = match ? match[1].length : 0;
      return Math.min(min, indent);
    }, Infinity);

  // Remove that indentation from all lines and add trailing newline
  return lines.map((line) => (line.length >= minIndent ? line.slice(minIndent) : line)).join('\n') + '\n';
}
