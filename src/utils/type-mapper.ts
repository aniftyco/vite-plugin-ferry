/**
 * Map PHP types to TypeScript types.
 */
export function mapPhpTypeToTs(phpType: string): string {
  const lower = phpType.toLowerCase();

  if (['int', 'integer'].includes(lower)) return 'number';
  if (['real', 'float', 'double', 'decimal'].includes(lower)) return 'number';
  if (lower === 'string') return 'string';
  if (['bool', 'boolean'].includes(lower)) return 'boolean';
  if (['array', 'json'].includes(lower)) return 'any[]';
  if (['datetime', 'date', 'immutable_datetime', 'immutable_date'].includes(lower)) return 'string';

  return 'any';
}

/**
 * Map docblock types to TypeScript types.
 */
export function mapDocTypeToTs(docType: string): string {
  let type = docType.trim();
  let nullable = false;

  if (type.startsWith('?')) {
    nullable = true;
    type = type.slice(1);
  }

  // Handle array shapes like "array {key: type, ...}"
  const arrShape = type.match(/^array\s*\{(.+)\}$/s);
  if (arrShape) {
    const inside = arrShape[1];
    const parts: string[] = [];
    const innerRe = /(?<key>[A-Za-z0-9_]+)\s*:\s*(?<type>[^,\n}]+)/g;

    for (const mm of inside.matchAll(innerRe)) {
      const k = (mm as any).groups.key;
      const t = (mm as any).groups.type.trim();
      parts.push(`${k}: ${mapDocTypeToTs(t)}`);
    }

    const obj = `{ ${parts.join('; ')} }`;
    return nullable ? `${obj} | null` : obj;
  }

  // Handle union types
  const parts = type
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);
  const mapped: string[] = [];

  for (const p of parts) {
    const low = p.toLowerCase();

    if (low === 'null') {
      mapped.push('null');
      continue;
    }
    if (low === 'mixed') {
      mapped.push('any');
      continue;
    }
    if (low === 'array') {
      mapped.push('any[]');
      continue;
    }
    if (['int', 'integer', 'float', 'double', 'number', 'decimal'].includes(low)) {
      mapped.push('number');
      continue;
    }
    if (['bool', 'boolean'].includes(low)) {
      mapped.push('boolean');
      continue;
    }
    if (low.startsWith('string')) {
      mapped.push('string');
      continue;
    }
    if (low === 'object' || low === 'stdclass') {
      mapped.push('Record<string, any>');
      continue;
    }

    // Handle array notation like "Foo[]"
    const arrMatch = p.match(/^(?<inner>[A-Za-z0-9_\\]+)\[\]$/);
    if (arrMatch) {
      const inner = arrMatch.groups!.inner.replace(/\\\\/g, '');
      mapped.push(`${inner}[]`);
      continue;
    }

    // Handle generic array like "array<Foo>"
    const genMatch = p.match(/array\s*<\s*([^,>\s]+)\s*>/i);
    if (genMatch) {
      const inner = genMatch[1].replace(/[^A-Za-z0-9_]/g, '');
      mapped.push(`${inner}[]`);
      continue;
    }

    // Handle Record types
    if (/record\s*<\s*[^>]+>/i.test(p) || p.includes('Record')) {
      mapped.push(p.replace('mixed', 'any'));
      continue;
    }

    // Default: sanitize and use as-is
    const san = p.replace(/[^A-Za-z0-9_\\[\]]/g, '').replace(/\\/g, '');
    mapped.push(san === '' ? 'any' : san);
  }

  if (nullable && !mapped.includes('null')) {
    mapped.push('null');
  }

  return Array.from(new Set(mapped)).join(' | ');
}

/**
 * Parse TypeScript object string to key-value pairs.
 */
export function parseTsObjectStringToPairs(tsObj: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  let inside = tsObj.trim();

  if (!inside.startsWith('{') || !inside.endsWith('}')) return pairs;
  inside = inside.slice(1, -1);

  let i = 0;
  while (i < inside.length) {
    // Skip whitespace and separators
    while (i < inside.length && (/\s/.test(inside[i]) || inside[i] === ';' || inside[i] === ',')) i++;

    // Extract key
    const keyMatch = inside.slice(i).match(/^[A-Za-z0-9_]+\??/);
    if (!keyMatch) break;

    const keyRaw = keyMatch[0];
    i += keyRaw.length;
    const key = keyRaw.endsWith('?') ? keyRaw.slice(0, -1) : keyRaw;

    // Skip to colon
    while (i < inside.length && /\s/.test(inside[i])) i++;
    if (i >= inside.length || inside[i] !== ':') break;
    i++;

    // Extract type
    while (i < inside.length && /\s/.test(inside[i])) i++;
    const typeStart = i;
    let depth = 0;

    while (i < inside.length) {
      const ch = inside[i];
      if (ch === '{' || ch === '(' || ch === '<') depth++;
      else if (ch === '}' || ch === ')' || ch === '>') {
        if (depth > 0) depth--;
      } else if ((ch === ';' || ch === ',') && depth === 0) break;
      i++;
    }

    const type = inside.slice(typeStart, i).trim();
    pairs[key] = type === '' ? 'any' : type;

    if (i < inside.length && (inside[i] === ';' || inside[i] === ',')) i++;
  }

  return pairs;
}
