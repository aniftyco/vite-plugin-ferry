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
 * Map a Laravel cast token to a TypeScript type by its BASE name, ignoring any `:params` tail
 * (`decimal:5` → `decimal`, `datetime:Y-m-d` → `datetime`, `encrypted:array` → `encrypted`).
 * This is the single source of truth both the metadata path (`resolveCast`) and the offline
 * static-parse path share for built-in casts, so a parameterized cast resolves identically with
 * or without a reachable database. Enum/class casts are handled by the callers, not here.
 */
export function mapBaseCastToTs(cast: string): string {
  const base = cast.split(':')[0].trim();
  const low = base.toLowerCase();

  // `decimal:<scale>` serializes to a formatted string, not a number.
  if (low === 'decimal') return 'string';
  if (['int', 'integer', 'real', 'float', 'double'].includes(low)) return 'number';
  if (['bool', 'boolean'].includes(low)) return 'boolean';
  if (['date', 'datetime', 'immutable_date', 'immutable_datetime', 'timestamp'].includes(low)) {
    return 'string';
  }
  if (['array', 'json', 'collection'].includes(low)) return 'any[]';
  if (low === 'object') return 'Record<string, any>';
  if (['string', 'hashed', 'encrypted'].includes(low)) return 'string';

  return mapPhpTypeToTs(base);
}

/**
 * The built-in Laravel cast base names `mapBaseCastToTs` resolves to a concrete type. Mirrors
 * the bases handled above so a caller can tell a built-in cast (`encrypted`, `object`, ...) apart
 * from an enum/class cast (`OrderStatus`, `Foo::class`) that must resolve through enum lookup.
 */
const KNOWN_BASE_CASTS = new Set([
  'decimal',
  'int',
  'integer',
  'real',
  'float',
  'double',
  'bool',
  'boolean',
  'date',
  'datetime',
  'immutable_date',
  'immutable_datetime',
  'timestamp',
  'array',
  'json',
  'collection',
  'object',
  'string',
  'hashed',
  'encrypted',
]);

/**
 * Whether a cast token names a built-in Laravel cast (ignoring any `:params` tail), i.e. one
 * `mapBaseCastToTs` maps to a concrete type. Enum/class casts and inline TS shapes are not.
 */
export function isKnownBaseCast(cast: string): boolean {
  return KNOWN_BASE_CASTS.has(cast.split(':')[0].trim().toLowerCase());
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
    const innerRe = /(?<key>[A-Za-z0-9_]+)(?<optional>\?)?\s*:\s*(?<type>[^,\n}]+)/g;

    for (const mm of inside.matchAll(innerRe)) {
      const k = (mm as any).groups.key;
      const optional = (mm as any).groups.optional ? '?' : '';
      const t = (mm as any).groups.type.trim();
      parts.push(`${k}${optional}: ${mapDocTypeToTs(t)}`);
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
