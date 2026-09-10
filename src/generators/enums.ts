import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Delivery } from '../delivery/index.js';
import { getPhpFiles, readFileSafe } from '../utils/file.js';
import { parseEnumContent, type EnumCase, type EnumDefinition } from '../utils/php-parser.js';

export type EnumRegisterOptions = {
  enumsDir: string;
  cwd: string;
  delivery: Delivery;
};

/** The ferry virtual/type module id enums are delivered under. */
export const ENUMS_MODULE_ID = '@ferry/enums';

/** Escape a value for embedding inside a single-quoted JS/TS string literal. */
function escapeSingle(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Render an enum value as a JS/TS literal: numbers stay numeric, strings get quoted. */
function renderValue(value: string | number): string {
  return typeof value === 'number' ? String(value) : `'${escapeSingle(value)}'`;
}

/** Collect enum definitions in a stable, name-sorted order for deterministic output. */
function sortedDefs(enums: Record<string, EnumDefinition>): EnumDefinition[] {
  return Object.keys(enums)
    .sort()
    .map((name) => enums[name]);
}

/**
 * Runtime for a single enum: a class extending the base `Enum`, one frozen static
 * instance per case. The label is passed only when the PHP enum defines `label()`.
 */
export function generateEnumRuntimeClass(def: EnumDefinition): string {
  const cases = def.cases.map((c: EnumCase) => {
    const args = [`'${escapeSingle(c.key)}'`, renderValue(c.value)];
    if (c.label !== undefined) {
      args.push(`'${escapeSingle(c.label)}'`);
    }
    return `  static ${c.key} = new ${def.name}(${args.join(', ')});`;
  });

  return [`export class ${def.name} extends Enum {`, ...cases, '}'].join('\n');
}

/**
 * The full `@ferry/enums` runtime module: the base-class import plus every generated
 * enum class. Served as a Vite virtual module.
 */
export function generateEnumsRuntime(enums: Record<string, EnumDefinition>): string {
  const defs = sortedDefs(enums);
  if (defs.length === 0) {
    return 'export {};\n';
  }

  const classes = defs.map(generateEnumRuntimeClass).join('\n\n');
  return `import { Enum } from '@ferry/enum';\n\n${classes}\n`;
}

/**
 * Types for a single enum: the narrowed value union and a class extending
 * `Enum<Value>` with statics narrowed to this enum's own value/key literals.
 */
export function generateEnumDtsClass(def: EnumDefinition): string {
  const name = def.name;
  const valueType = `${name}Value`;
  const valueUnion = def.cases.map((c) => renderValue(c.value)).join(' | ');
  const keyUnion = def.cases.map((c) => `'${escapeSingle(c.key)}'`).join(' | ');

  return [
    `export type ${valueType} = ${valueUnion};`,
    `export class ${name} extends Enum<${valueType}> {`,
    ...def.cases.map((c) => `  static readonly ${c.key}: ${name};`),
    `  readonly key: ${keyUnion};`,
    `  readonly value: ${valueType};`,
    `  readonly label: string | undefined;`,
    `  static from(value: ${valueType}): ${name};`,
    `  static values(): ${valueType}[];`,
    `  static keys(): Array<${keyUnion}>;`,
    `  static cases(): ${name}[];`,
    `  static options(): Array<{ value: ${valueType}; label: string | undefined }>;`,
    `}`,
  ].join('\n');
}

/** Indent every non-empty line of a block by two spaces. */
function indentBlock(block: string): string {
  return block
    .split('\n')
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join('\n');
}

/**
 * The `declare module '@ferry/enums'` block for the ambient `index.d.ts`. The base
 * `Enum` import lives inside the block, which keeps the ambient file script-style.
 */
export function generateEnumsDts(enums: Record<string, EnumDefinition>): string {
  const defs = sortedDefs(enums);
  if (defs.length === 0) {
    return `declare module '${ENUMS_MODULE_ID}' {}`;
  }

  const inner = [`import { Enum } from '@ferry/enum';`, '', defs.map(generateEnumDtsClass).join('\n\n')].join('\n');
  return `declare module '${ENUMS_MODULE_ID}' {\n${indentBlock(inner)}\n}`;
}

/**
 * Collect all enum definitions from the enums directory.
 * This is a plugin-level function that handles file I/O.
 */
export function collectEnums(enumsDir: string, cwd: string): Record<string, EnumDefinition> {
  const enums: Record<string, EnumDefinition> = {};

  if (!existsSync(enumsDir)) {
    return enums;
  }

  const enumFiles = getPhpFiles(enumsDir);

  for (const file of enumFiles) {
    try {
      const enumPath = join(enumsDir, file);
      const content = readFileSafe(enumPath);
      if (!content) continue;

      // Calculate relative path from project root for source mapping
      const relativePhpPath = relative(cwd, enumPath);
      const def = parseEnumContent(content, relativePhpPath);
      if (def) {
        enums[def.name] = def;
      }
    } catch (e) {
      // Ignore parse errors
      console.warn(`Failed to parse enum file: ${file}`, e);
    }
  }

  return enums;
}

/**
 * Collect enums and register their runtime (virtual module) and types (d.ts block)
 * with the delivery layer under `@ferry/enums`. Called on every generation pass and
 * on enum changes in dev. Does not write the ambient file; the caller runs `writeTypes()`.
 */
export function registerEnums({ enumsDir, cwd, delivery }: EnumRegisterOptions): void {
  const enums = collectEnums(enumsDir, cwd);
  delivery.virtual.register(ENUMS_MODULE_ID, generateEnumsRuntime(enums));
  delivery.dts.register(ENUMS_MODULE_ID, generateEnumsDts(enums));
}
