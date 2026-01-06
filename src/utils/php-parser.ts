import { readFileSafe } from './file.js';

export type EnumCase = {
  key: string;
  value: string;
  label?: string;
};

export type EnumDefinition = {
  name: string;
  backing: string | null;
  cases: EnumCase[];
};

/**
 * Parse a PHP enum file and extract its definition.
 */
export function parseEnumFile(enumPath: string): EnumDefinition | null {
  const content = readFileSafe(enumPath);
  if (!content) return null;

  // Extract enum name and backing type
  const enumMatch = content.match(/enum\s+([A-Za-z0-9_]+)\s*(?:\:\s*([A-Za-z0-9_]+))?/);
  if (!enumMatch) return null;

  const name = enumMatch[1];
  const backing = enumMatch[2] ? enumMatch[2].toLowerCase() : null;

  // Extract enum cases
  const cases: EnumCase[] = [];
  const explicitCases = [...content.matchAll(/case\s+([A-Za-z0-9_]+)\s*=\s*'([^']*)'\s*;/g)];

  if (explicitCases.length) {
    for (const match of explicitCases) {
      cases.push({ key: match[1], value: match[2] });
    }
  } else {
    const implicitCases = [...content.matchAll(/case\s+([A-Za-z0-9_]+)\s*;/g)];
    for (const match of implicitCases) {
      cases.push({ key: match[1], value: match[1] });
    }
  }

  // Parse getLabel() method if it exists
  const labelMethodMatch = content.match(
    /function\s+getLabel\s*\(\s*\)\s*:\s*string\s*\{[\s\S]*?return\s+match\s*\(\s*\$this\s*\)\s*\{([\s\S]*?)\};/
  );

  if (labelMethodMatch) {
    const matchBody = labelMethodMatch[1];
    const labelMatches = [...matchBody.matchAll(/self::([A-Za-z0-9_]+)\s*=>\s*'([^']*)'/g)];

    for (const labelMatch of labelMatches) {
      const caseKey = labelMatch[1];
      const labelValue = labelMatch[2];
      const enumCase = cases.find((c) => c.key === caseKey);
      if (enumCase) {
        enumCase.label = labelValue;
      }
    }
  }

  return { name, backing, cases };
}

/**
 * Parse PHP array pairs from a string like "'key' => 'value'".
 */
export function parsePhpArrayPairs(inside: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  const re = /["'](?<key>[A-Za-z0-9_]+)["']\s*=>\s*(?<val>[^,\n]+)/g;

  for (const m of inside.matchAll(re)) {
    let val = (m as any).groups.val.trim();
    val = val.replace(/[,\s]*$/g, '');

    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    if (val.endsWith('::class')) {
      val = val.slice(0, -7);
    }

    pairs[(m as any).groups.key] = val;
  }

  return pairs;
}

/**
 * Extract model casts from a PHP model file.
 */
export function getModelCasts(modelPath: string): Record<string, string> {
  const content = readFileSafe(modelPath);
  if (!content) return {};

  // Try protected $casts property
  const castsMatch = content.match(/protected\s+\$casts\s*=\s*\[([^\]]*)\]/s);
  if (castsMatch) {
    return parsePhpArrayPairs(castsMatch[1]);
  }

  // Try casts() method
  const castsMethodMatch = content.match(/function\s+casts\s*\([^)]*\)\s*\{[^}]*return\s*\[([^\]]*)\]/s);
  if (castsMethodMatch) {
    return parsePhpArrayPairs(castsMethodMatch[1]);
  }

  // Try class-based casts
  const matches = [...content.matchAll(/["'](?<key>[A-Za-z0-9_]+)["']\s*=>\s*(?<class>[A-Za-z0-9_\\]+)::class/g)];
  const res: Record<string, string> = {};

  for (const m of matches) {
    const k = (m as any).groups.key;
    let v = (m as any).groups.class;
    v = v.replace(/^\\+/, '');
    res[k] = v;
  }

  return res;
}

/**
 * Extract docblock array shape from PHP file content.
 */
export function extractDocblockArrayShape(phpContent: string): Record<string, string> | null {
  const match = phpContent.match(/@return\s+array\s*\{/s);
  if (!match) return null;

  const startPos = match.index!;
  const openBracePos = phpContent.indexOf('{', startPos);
  if (openBracePos === -1) return null;

  // Find matching closing brace
  let depth = 0;
  let pos = openBracePos;
  let endPos: number | null = null;

  while (pos < phpContent.length) {
    const ch = phpContent[pos];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        endPos = pos;
        break;
      }
    }
    pos++;
  }

  if (endPos === null) return null;

  const inside = phpContent.slice(openBracePos + 1, endPos);
  const pairs: Record<string, string> = {};
  let i = 0;

  while (i < inside.length) {
    // Skip whitespace and commas
    while (i < inside.length && (inside[i].match(/\s/) || inside[i] === ',')) i++;
    if (i >= inside.length) break;

    // Extract key
    const keyMatch = inside.slice(i).match(/^[A-Za-z0-9_]+/);
    if (!keyMatch) break;

    const key = keyMatch[0];
    i += key.length;

    // Skip to colon
    while (i < inside.length && /\s/.test(inside[i])) i++;
    if (i >= inside.length || inside[i] !== ':') break;
    i++;

    // Extract type
    while (i < inside.length && /\s/.test(inside[i])) i++;
    const typeStart = i;
    let depthCur = 0;

    while (i < inside.length) {
      const ch = inside[i];
      if (ch === '{' || ch === '<' || ch === '(') depthCur++;
      else if (ch === '}' || ch === '>' || ch === ')') {
        if (depthCur > 0) depthCur--;
      } else if (ch === ',' && depthCur === 0) break;
      i++;
    }

    const type = inside.slice(typeStart, i).trim();
    if (type) pairs[key] = type;
    if (i < inside.length && inside[i] === ',') i++;
  }

  return pairs;
}

/**
 * Extract the return array block from a toArray() method in a PHP resource.
 */
export function extractReturnArrayBlock(phpContent: string): string | null {
  const match = phpContent.match(/function\s+toArray\s*\([^)]*\)\s*:\s*array\s*\{([\s\S]*?)\n\s*\}/);
  if (!match) return null;

  const body = match[1];
  const returnMatch = body.match(/return\s*\[\s*([\s\S]*?)\s*\];/);
  if (!returnMatch) return null;

  return returnMatch[1];
}
