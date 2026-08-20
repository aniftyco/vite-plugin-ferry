import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, relative } from 'node:path';
import type { Delivery } from '../delivery/index.js';
import { getPhpFiles, readFileSafe } from '../utils/file.js';
import {
  extractDocblockArrayShape,
  extractFerryAnnotations,
  parseResourceFieldsAst,
  type EnumDefinition,
  type ResourceFieldInfo,
} from '../utils/php-parser.js';
import { mapDocTypeToTs, mapPhpTypeToTs } from '../utils/type-mapper.js';
import { collectEnums } from './enums.js';
import { runArtisan } from '../utils/artisan.js';
import { logWarn } from '../utils/banner.js';

/** The ferry virtual/type module id resources are delivered under. */
export const RESOURCES_MODULE_ID = '@ferry/resources';

/** The module enum types are imported from inside the resources d.ts block. */
const ENUMS_MODULE_ID = '@ferry/enums';

/** Resources are type-only, so the virtual module has no runtime — just a valid empty module. */
export const RESOURCE_RUNTIME = 'export {};\n';

/** One column of a table, as `Schema::getColumns()` reports it. */
export type ColumnMeta = {
  name: string;
  type_name: string;
  nullable: boolean;
  default?: unknown;
};

/** A model's metadata: its table's columns and its `getCasts()` map. */
export type ModelMeta = {
  table?: string;
  columns: ColumnMeta[];
  casts: Record<string, string>;
};

/** The metadata dump, keyed by model class short name (`Order`, `User`). */
export type MetadataDump = Record<string, ModelMeta>;

/** A resolved field: its TypeScript type and whether the key is optional. */
export type MergedField = {
  type: string;
  optional: boolean;
};

/** A resource's final shape: either a resolved field set or a whole-resource fallback. */
export type ResourceEntry =
  | { kind: 'shape'; fields: Record<string, MergedField> }
  | { kind: 'fallback'; record: string };

/** A resource's static analysis result plus the inputs the merge needs. */
export type ResourceInput = {
  className: string;
  /** The model backing this resource: the class name with the `Resource` suffix removed. */
  model: string;
  /** Static `toArray()` fields, or null when the resource couldn't be analyzed at all. */
  staticFields: Record<string, ResourceFieldInfo> | null;
  /** `@ferry <field> <type>` docblock overrides. */
  annotations: Record<string, string>;
  /** Enum names collected while resolving static casts. */
  enumNames: string[];
};

export type ResourceRegisterOptions = {
  resourcesDir: string;
  modelsDir: string;
  cwd: string;
  delivery: Delivery;
  /** Fallback type for undecidable fields: `false` → `any` (default), `true` → `unknown`. */
  strict?: boolean;
};

// ---------------------------------------------------------------------------
// Metadata dump parsing (Schema::getColumns + getCasts) and leaf-type mapping
// ---------------------------------------------------------------------------

/** Cast tokens that are primitives, not enum/value-object class names. */
const PRIMITIVE_CASTS = new Set([
  'int',
  'integer',
  'real',
  'float',
  'double',
  'decimal',
  'string',
  'bool',
  'boolean',
  'object',
  'array',
  'json',
  'collection',
  'date',
  'datetime',
  'immutable_date',
  'immutable_datetime',
  'timestamp',
  'hashed',
  'encrypted',
]);

/**
 * Normalize and validate a raw metadata payload (parsed from the tinker dump's JSON)
 * into a `MetadataDump`. Defensive: ignores malformed entries rather than throwing, so
 * a partial or unexpected dump degrades to whatever it could read.
 */
export function parseMetadataDump(raw: unknown): MetadataDump {
  const out: MetadataDump = {};
  if (!raw || typeof raw !== 'object') return out;

  for (const [model, value] of Object.entries(raw as Record<string, any>)) {
    if (!value || typeof value !== 'object') continue;

    const columns: ColumnMeta[] = Array.isArray(value.columns)
      ? value.columns
          .filter((c: any) => c && typeof c.name === 'string')
          .map((c: any) => ({
            name: c.name,
            type_name: String(c.type_name ?? c.type ?? ''),
            nullable: Boolean(c.nullable),
            default: c.default,
          }))
      : [];

    const casts: Record<string, string> = {};
    if (value.casts && typeof value.casts === 'object') {
      for (const [attr, cast] of Object.entries(value.casts)) {
        if (typeof cast === 'string') casts[attr] = cast;
      }
    }

    out[model] = {
      table: typeof value.table === 'string' ? value.table : undefined,
      columns,
      casts,
    };
  }

  return out;
}

/** Map a database column type name to a TypeScript leaf type. */
export function mapColumnType(typeName: string, nullable: boolean): string {
  const base = mapDbType(typeName);
  return nullable ? `${base} | null` : base;
}

function mapDbType(typeName: string): string {
  const low = typeName.toLowerCase().split('(')[0].trim();

  if (/(^|_)(int|integer|bigint|smallint|tinyint|mediumint)$/.test(low) || low === 'serial' || low === 'bigserial') {
    return 'number';
  }
  if (['decimal', 'numeric', 'float', 'double', 'real', 'money'].includes(low)) return 'number';
  if (['bool', 'boolean'].includes(low)) return 'boolean';
  if (['json', 'jsonb'].includes(low)) return 'any[]';
  if (
    low.includes('char') ||
    low.includes('text') ||
    ['uuid', 'string', 'enum', 'inet', 'cidr', 'macaddr'].includes(low)
  ) {
    return 'string';
  }
  if (low.includes('date') || low.includes('time')) return 'string';

  return 'any';
}

/**
 * Resolve a cast token to a TypeScript type. A class-name cast (an FQCN or a PascalCase
 * name) resolves to a ferry enum ONLY when its short name is in `knownEnums` — the set of
 * enums ferry actually generates into `@ferry/enums`. A class cast that is NOT a known
 * ferry enum (Laravel's built-in `AsCollection`/`AsArrayObject`/`AsStringable`, or any
 * custom `Castable` / value object) is something ferry can't type precisely: it returns
 * `unresolved` so the caller degrades it, rather than emitting a broken `@ferry/enums`
 * import for a member that module never exports.
 */
export function resolveCast(
  cast: string,
  knownEnums: Set<string> = new Set()
): { type: string; enum?: string; unresolved?: boolean } {
  const raw = cast.split(':')[0].trim();
  const low = raw.toLowerCase();

  // Class-name cast: `App\Enums\OrderStatus`, `AsCollection::class` -> `AsCollection`, etc.
  if ((raw.includes('\\') || /^[A-Z][A-Za-z0-9_]*$/.test(raw)) && !PRIMITIVE_CASTS.has(low)) {
    const short = raw.split('\\').pop()!.replace(/::class$/, '');
    if (knownEnums.has(short)) {
      return { type: short, enum: short };
    }
    return { type: '', unresolved: true };
  }

  if (['int', 'integer', 'real', 'float', 'double', 'decimal'].includes(low)) return { type: 'number' };
  if (['bool', 'boolean'].includes(low)) return { type: 'boolean' };
  if (['date', 'datetime', 'immutable_date', 'immutable_datetime', 'timestamp'].includes(low)) {
    return { type: 'string' };
  }
  if (['array', 'json', 'collection'].includes(low)) return { type: 'any[]' };
  if (low === 'object') return { type: 'Record<string, any>' };
  if (['string', 'hashed', 'encrypted'].includes(low)) return { type: 'string' };

  return { type: mapPhpTypeToTs(raw) };
}

// ---------------------------------------------------------------------------
// Merge: static shape + metadata leaf types + annotations + degradation
// ---------------------------------------------------------------------------

export type MergeResourceOptions = {
  resourceName: string;
  model: string;
  staticFields: Record<string, ResourceFieldInfo>;
  metadata: MetadataDump;
  annotations: Record<string, string>;
  strict: boolean;
  /** The enum names ferry generates into `@ferry/enums`; a class cast is only treated as
   * an enum when its short name is in this set. */
  knownEnums: Set<string>;
  /** Mutated: enum names referenced by resolved fields are added here. */
  enumNames: Set<string>;
  /** Mutated: a degradation warning per undecidable field is pushed here. */
  warnings: string[];
};

/**
 * Merge one resource's static shape with the metadata dump. Static analysis decides
 * WHICH keys exist and whether they're optional; the metadata dump decides WHAT type
 * each leaf is (including `null` from a nullable column). Precedence per field:
 *
 * 1. `@ferry` annotation → the raw TS type, verbatim.
 * 2. Metadata leaf type via the field's source column (a cast wins over the raw column).
 * 3. Undecidable field → the strict-mode fallback (`unknown`) or `any`, plus a warning.
 * 4. Otherwise the static type.
 */
export function mergeResourceFields(options: MergeResourceOptions): Record<string, MergedField> {
  const { resourceName, model, staticFields, metadata, annotations, strict, knownEnums, enumNames, warnings } = options;

  const meta = metadata[model];
  const columns = new Map<string, ColumnMeta>((meta?.columns ?? []).map((c) => [c.name, c]));
  const casts = meta?.casts ?? {};

  const degrade = (field: string, optional: boolean): MergedField => {
    const fallback = strict ? 'unknown' : 'any';
    warnings.push(
      `${resourceName}.${field} could not be resolved statically; typed as \`${fallback}\`. ` +
        `Add \`@ferry ${field} <TS type>\` to toArray()'s docblock to pin it.`
    );
    return { type: fallback, optional };
  };

  const out: Record<string, MergedField> = {};

  for (const [field, info] of Object.entries(staticFields)) {
    const optional = info.optional;

    // 1. Annotation override — emitted verbatim, clears any warning.
    if (annotations[field] !== undefined) {
      out[field] = { type: annotations[field], optional };
      continue;
    }

    // 2. Metadata leaf type via the source column (cast beats column type). Nullability
    //    of the underlying column composes with either — a nullable column adds `| null`.
    const column = info.column;
    if (column) {
      const col = columns.get(column);
      const nullable = col?.nullable ?? false;

      if (casts[column] !== undefined) {
        const resolved = resolveCast(casts[column], knownEnums);
        // A class cast that isn't a known ferry enum can't be typed precisely — degrade it
        // rather than importing a member `@ferry/enums` never exports.
        if (resolved.unresolved) {
          out[field] = degrade(field, optional);
          continue;
        }
        if (resolved.enum) enumNames.add(resolved.enum);
        out[field] = { type: nullable ? `${resolved.type} | null` : resolved.type, optional };
        continue;
      }
      if (col) {
        out[field] = { type: mapColumnType(col.type_name, col.nullable), optional };
        continue;
      }
    }

    // 3. Undecidable field — degrade instead of failing the build.
    if (info.undecidable) {
      out[field] = degrade(field, optional);
      continue;
    }

    // 4. Static type (includes enum names resolved from static casts).
    out[field] = { type: info.type, optional };
  }

  return out;
}

/**
 * Build the final resource entries from the collected inputs and the metadata dump.
 * Returns the entries, every enum name referenced (for the block's import), and the
 * degradation warnings. Never throws — an unanalyzable resource becomes a fallback
 * `Record<string, any|unknown>` with a warning.
 */
export function buildResources(
  inputs: ResourceInput[],
  metadata: MetadataDump,
  strict: boolean,
  knownEnums: Set<string> = new Set()
): { resources: Record<string, ResourceEntry>; enumNames: Set<string>; warnings: string[] } {
  const resources: Record<string, ResourceEntry> = {};
  const enumNames = new Set<string>();
  const warnings: string[] = [];
  const fallbackRecord = strict ? 'unknown' : 'any';

  for (const input of inputs) {
    for (const name of input.enumNames) enumNames.add(name);

    if (!input.staticFields) {
      resources[input.className] = { kind: 'fallback', record: fallbackRecord };
      warnings.push(
        `${input.className}: could not statically analyze toArray(); typed as \`Record<string, ${fallbackRecord}>\`.`
      );
      continue;
    }

    const fields = mergeResourceFields({
      resourceName: input.className,
      model: input.model,
      staticFields: input.staticFields,
      metadata,
      annotations: input.annotations,
      strict,
      knownEnums,
      enumNames,
      warnings,
    });

    resources[input.className] = { kind: 'shape', fields };
  }

  return { resources, enumNames, warnings };
}

// ---------------------------------------------------------------------------
// d.ts block rendering
// ---------------------------------------------------------------------------

/** Escape a name for use in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether a TypeScript type string references `name` as a whole identifier. */
function typeContainsName(type: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`).test(type);
}

/** Indent every non-empty line of a block by two spaces. */
function indentBlock(block: string): string {
  return block
    .split('\n')
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join('\n');
}

/** Render one resource as an `export type` declaration. */
function renderResourceType(name: string, entry: ResourceEntry): string {
  if (entry.kind === 'fallback') {
    return `export type ${name} = Record<string, ${entry.record}>;`;
  }

  const fields = Object.entries(entry.fields);
  if (fields.length === 0) {
    return `export type ${name} = {};`;
  }

  const lines = fields.map(([key, field]) => `  ${key}${field.optional ? '?' : ''}: ${field.type};`);
  return [`export type ${name} = {`, ...lines, `};`].join('\n');
}

/**
 * The `declare module '@ferry/resources'` block for the ambient `index.d.ts`. Any
 * referenced enum is imported from `@ferry/enums` at the top of the block — the import
 * is block-scoped, so it does NOT flip the ambient file to module mode (the same pattern
 * the enums block uses to import the base `Enum`).
 */
export function generateResourcesDtsBlock(resources: Record<string, ResourceEntry>, enumNames: Set<string>): string {
  const names = Object.keys(resources).sort();
  if (names.length === 0) {
    return `declare module '${RESOURCES_MODULE_ID}' {}`;
  }

  // Only import enums actually referenced by a rendered field type.
  const used = new Set<string>();
  for (const name of names) {
    const entry = resources[name];
    if (entry.kind !== 'shape') continue;
    for (const field of Object.values(entry.fields)) {
      for (const enumName of enumNames) {
        if (typeContainsName(field.type, enumName)) used.add(enumName);
      }
    }
  }

  const parts: string[] = [];
  if (used.size > 0) {
    parts.push(`import { ${[...used].sort().join(', ')} } from '${ENUMS_MODULE_ID}';`);
    parts.push('');
  }
  parts.push(names.map((name) => renderResourceType(name, resources[name])).join('\n\n'));

  const inner = parts.join('\n');
  return `declare module '${RESOURCES_MODULE_ID}' {\n${indentBlock(inner)}\n}`;
}

// ---------------------------------------------------------------------------
// Collection + metadata dump (file I/O + PHP)
// ---------------------------------------------------------------------------

/** Map a docblock array shape's field types to TypeScript. */
function mapDocShape(docShape: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, type] of Object.entries(docShape)) {
    result[key] = mapDocTypeToTs(type);
  }
  return result;
}

/**
 * Read every resource file and statically analyze its `toArray()`. Pure file I/O plus
 * the `php-parser` static pass — no PHP process. Returns one input per resource.
 */
export function collectResourceInputs(options: {
  resourcesDir: string;
  modelsDir: string;
  enumsDir: string;
  cwd: string;
}): ResourceInput[] {
  const { resourcesDir, modelsDir, enumsDir, cwd } = options;

  if (!existsSync(resourcesDir)) {
    return [];
  }

  const inputs: ResourceInput[] = [];

  for (const file of getPhpFiles(resourcesDir)) {
    try {
      const filePath = join(resourcesDir, file);
      const content = readFileSafe(filePath) || '';
      const className = parse(file).name;
      const relativePhpPath = relative(cwd, filePath);

      const collectedEnums: Record<string, EnumDefinition> = {};
      const docShape = extractDocblockArrayShape(content);
      const mappedDocShape = docShape ? mapDocShape(docShape) : null;

      const staticFields = parseResourceFieldsAst(content, {
        resourcesDir,
        modelsDir,
        enumsDir,
        docShape: mappedDocShape,
        collectedEnums,
        filePath: relativePhpPath,
      });

      inputs.push({
        className,
        model: className.replace(/Resource$/, ''),
        staticFields,
        annotations: extractFerryAnnotations(content),
        enumNames: Object.keys(collectedEnums),
      });
    } catch (e) {
      logWarn('resources', `Failed to parse resource file: ${file} (${e})`);
    }
  }

  return inputs;
}

/**
 * Build the PHP dump script. A temp file (rather than a giant inline `--execute`
 * string) keeps the multi-statement expression off the shell command line, where its
 * quoting is fragile; tinker just `require`s it. Each model is guarded independently so
 * a missing class or table skips that model instead of aborting the whole dump. Output
 * is wrapped in sentinels so tinker's own banner/echo can be stripped.
 */
function buildDumpScript(modelClasses: string[]): string {
  const list = modelClasses.map((c) => `'${c.replace(/\\/g, '\\\\')}'`).join(', ');
  return [
    '<?php',
    '$ferryOut = [];',
    `$ferryModels = [${list}];`,
    'foreach ($ferryModels as $ferryClass) {',
    '    if (!class_exists($ferryClass)) { continue; }',
    '    try {',
    '        $ferryModel = new $ferryClass();',
    '        $ferryTable = $ferryModel->getTable();',
    '        $ferryOut[class_basename($ferryClass)] = [',
    "            'table' => $ferryTable,",
    "            'columns' => \\Illuminate\\Support\\Facades\\Schema::getColumns($ferryTable),",
    "            'casts' => $ferryModel->getCasts(),",
    '        ];',
    '    } catch (\\Throwable $ferryErr) { continue; }',
    '}',
    "echo '__FERRY_META_START__' . json_encode($ferryOut) . '__FERRY_META_END__';",
    '',
  ].join('\n');
}

/** Extract the sentinel-wrapped JSON payload from tinker's stdout. */
function extractSentinel(stdout: string): string | null {
  const start = stdout.indexOf('__FERRY_META_START__');
  const end = stdout.indexOf('__FERRY_META_END__');
  if (start === -1 || end === -1 || end < start) return null;
  return stdout.slice(start + '__FERRY_META_START__'.length, end);
}

/**
 * Dump model metadata via `php artisan tinker`. Requires a live Laravel app with a
 * reachable database; when tinker is unavailable, fails, or returns nothing parseable,
 * it degrades to an empty dump (resources then fall back to their static shape) rather
 * than breaking the build.
 */
export function dumpMetadata(cwd: string, models: string[]): MetadataDump {
  if (models.length === 0) return {};

  const script = buildDumpScript(models.map((m) => `App\\Models\\${m}`));
  const tmpFile = join(tmpdir(), `ferry-metadata-${process.pid}-${Date.now()}.php`);

  try {
    writeFileSync(tmpFile, script, 'utf8');
    const stdout = runArtisan(cwd, ['tinker', '--execute', `require '${tmpFile}';`]);
    if (!stdout) return {};

    const json = extractSentinel(stdout);
    if (!json) return {};

    return parseMetadataDump(JSON.parse(json));
  } catch (e) {
    logWarn('resources', `Metadata dump failed: ${e}`);
    return {};
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // Temp file may never have been written; ignore.
    }
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Collect resources, dump model metadata, merge them, and register the `@ferry/resources`
 * runtime (an empty type-only virtual module) plus the `declare module '@ferry/resources'`
 * d.ts block with the delivery layer. Degradation warnings are logged. Called on every
 * generation pass and on resource/model changes in dev. Does not write the ambient file;
 * the caller runs `writeTypes()`.
 */
export function registerResources({ resourcesDir, modelsDir, cwd, delivery, strict = false }: ResourceRegisterOptions): void {
  const enumsDir = join(cwd, 'app/Enums');

  const inputs = collectResourceInputs({ resourcesDir, modelsDir, enumsDir, cwd });
  const models = [...new Set(inputs.map((i) => i.model))].filter(Boolean);
  const metadata = dumpMetadata(cwd, models);

  // The enums ferry actually generates into `@ferry/enums`. A metadata cast is only
  // treated as an enum reference when its class short name is in this set.
  const knownEnums = new Set(Object.keys(collectEnums(enumsDir, cwd)));

  const { resources, enumNames, warnings } = buildResources(inputs, metadata, strict, knownEnums);
  for (const warning of warnings) logWarn('resources', warning);

  delivery.virtual.register(RESOURCES_MODULE_ID, RESOURCE_RUNTIME);
  delivery.dts.register(RESOURCES_MODULE_ID, generateResourcesDtsBlock(resources, enumNames));
}
