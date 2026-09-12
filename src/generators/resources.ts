import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, relative } from 'node:path';
import type { Delivery } from '../delivery/index.js';
import { runArtisan } from '../utils/artisan.js';
import { logWarn } from '../utils/banner.js';
import { getPhpFilesRecursive, readFileSafe } from '../utils/file.js';
import {
  extractDocblockArrayShape,
  extractExtendsShortName,
  extractFerryAnnotations,
  extractMixinModel,
  parseModelPropertyShapes,
  parseModelPropertyTypes,
  parseResourceFieldsAst,
  resourceMergesParent,
  type EnumDefinition,
  type ResourceFieldInfo,
} from '../utils/php-parser.js';
import { renderKey } from '../utils/ts-keys.js';
import { mapDocTypeToTs, mapPhpTypeToTs } from '../utils/type-mapper.js';
import { collectEnums } from './enums.js';

/** The ferry virtual/type module id resources are delivered under. */
export const RESOURCES_MODULE_ID = '@ferry/resources';

/** The module enum types are imported from inside the resources d.ts block. */
const ENUMS_MODULE_ID = '@ferry/enums';

/** The module the paginator envelope generics are imported from inside the resources d.ts block. */
const PAGINATION_MODULE_ID = '@ferry/pagination';

/** The fixed set of paginator envelope generics ferry emits from `@ferry/pagination`. */
const PAGINATION_ENVELOPE_TYPES = ['LengthAwarePaginated', 'SimplePaginated', 'CursorPaginated'];

/** Resources are type-only, so the virtual module has no runtime — just a valid empty module. */
export const RESOURCE_RUNTIME = 'export {};\n';

/** One column of a table, as `Schema::getColumns()` reports it. */
export type ColumnMeta = {
  name: string;
  type_name: string;
  nullable: boolean;
  default?: unknown;
};

/** A related model's columns and casts, dumped by walking a relation method. Lets the merge
 * resolve a `$this->author->name` read to the author model's real column/cast type. */
export type RelatedMeta = {
  columns: ColumnMeta[];
  casts: Record<string, string>;
};

/** A model's metadata: its table's columns, its `getCasts()` map, and — for the relations
 * a resource actually reads through (`$this->rel->attr`) — the related model's metadata. */
export type ModelMeta = {
  table?: string;
  columns: ColumnMeta[];
  casts: Record<string, string>;
  relations?: Record<string, RelatedMeta>;
  /** `$appends` accessor names — serialized in addition to the columns. Typed via the model's
   * scalar `@property` docblock. Absent in older/stale dumps; treated as empty then. */
  appends?: string[];
  /** `$hidden` attribute names — excluded from the serialized shape. Absent → empty. */
  hidden?: string[];
  /** `$visible` whitelist. When non-empty, ONLY these attributes serialize. Absent → empty. */
  visible?: string[];
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
  /** Class-level `@property array{...} $field` object shapes on the backing model, mapped to
   * TS object literals. Each refines an array/json/collection field's bare `any[]` default. */
  propertyShapes: Record<string, string>;
  /** Scalar `@property`/`@property-read` types on the backing model (mapped to TS), keyed by
   * name. Types the model's `$appends` accessors when the resource merges the parent. */
  propertyTypes?: Record<string, string>;
  /** True when `toArray()` is `array_merge(parent::toArray(...), [...])`: the merge seeds the
   * `@mixin` model's serialized shape before the inline keys, which then override it. */
  mergesParent?: boolean;
  /** Short class name of the resource's `extends` parent, or undefined when it has none. When the
   * parent resolves to an app-local Resource (a file in `resourcesDir`) and the resource merges
   * the parent, the merge seeds THAT parent resource's resolved `toArray` fields — not the model
   * shape. A vendor base (`JsonResource`) has no such file and keeps the model-shape seeding. */
  parentResource?: string;
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
function parseColumns(raw: unknown): ColumnMeta[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c: any) => c && typeof c.name === 'string')
    .map((c: any) => ({
      name: c.name,
      type_name: String(c.type_name ?? c.type ?? ''),
      nullable: Boolean(c.nullable),
      default: c.default,
    }));
}

/** Normalize a raw value into a string array, dropping non-string members. */
function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

function parseCasts(raw: unknown): Record<string, string> {
  const casts: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [attr, cast] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof cast === 'string') casts[attr] = cast;
    }
  }
  return casts;
}

export function parseMetadataDump(raw: unknown): MetadataDump {
  const out: MetadataDump = {};
  if (!raw || typeof raw !== 'object') return out;

  for (const [model, value] of Object.entries(raw as Record<string, any>)) {
    if (!value || typeof value !== 'object') continue;

    let relations: Record<string, RelatedMeta> | undefined;
    if (value.relations && typeof value.relations === 'object') {
      relations = {};
      for (const [rel, relValue] of Object.entries(value.relations as Record<string, any>)) {
        if (!relValue || typeof relValue !== 'object') continue;
        relations[rel] = { columns: parseColumns(relValue.columns), casts: parseCasts(relValue.casts) };
      }
    }

    out[model] = {
      table: typeof value.table === 'string' ? value.table : undefined,
      columns: parseColumns(value.columns),
      casts: parseCasts(value.casts),
      ...(relations ? { relations } : {}),
      appends: parseStringArray(value.appends),
      hidden: parseStringArray(value.hidden),
      visible: parseStringArray(value.visible),
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
 * name) resolves to a ferry enum's `<Enum>Value` backing-value type ONLY when its short name
 * is in `knownEnums` — the set of enums ferry actually generates into `@ferry/enums` (the
 * field carries the raw backing value over JSON, not an Enum instance). A class cast that is NOT a known
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
    const short = raw
      .split('\\')
      .pop()!
      .replace(/::class$/, '');
    if (knownEnums.has(short)) {
      // Resource data arrives as the enum's raw backing value over JSON, not an instance,
      // so the field types as the generated `<Enum>Value` union rather than the Enum class.
      return { type: `${short}Value`, enum: short };
    }
    return { type: '', unresolved: true };
  }

  // `decimal:<scale>` serializes to a formatted string, not a number.
  if (low === 'decimal') return { type: 'string' };
  if (['int', 'integer', 'real', 'float', 'double'].includes(low)) return { type: 'number' };
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

/**
 * Normalize a scalar union: dedupe members and collapse every `null` into a single trailing
 * `| null`. Scoped to the `value | default` union the merge assembles, so `string | string`
 * becomes `string` and `string | null | string` becomes `string | null`, order-independent.
 */
export function normalizeUnion(type: string): string {
  const members = type
    .split('|')
    .map((m) => m.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  let hasNull = false;

  for (const member of members) {
    if (member === 'null') {
      hasNull = true;
      continue;
    }
    if (!seen.has(member)) {
      seen.add(member);
      out.push(member);
    }
  }
  if (hasNull) out.push('null');

  return out.join(' | ');
}

export type MergeResourceOptions = {
  resourceName: string;
  model: string;
  staticFields: Record<string, ResourceFieldInfo>;
  metadata: MetadataDump;
  annotations: Record<string, string>;
  /** Backing-model `@property array{...}` object shapes (TS literals), keyed by field. Each
   * refines the bare `any[]` an array/json/collection cast (or a json column) resolves to. */
  propertyShapes?: Record<string, string>;
  /** Backing-model scalar `@property` types (mapped to TS), keyed by name. Types the model's
   * `$appends` accessors when `mergesParent` is set. */
  propertyTypes?: Record<string, string>;
  /** Seed the `@mixin` model's serialized shape (columns − `$hidden`, plus `$appends`) before
   * the inline keys — the parent contribution of an `array_merge(parent::toArray(...), [...])`. */
  mergesParent?: boolean;
  /** When the merged parent is an app-local Resource, its already-resolved `toArray` fields.
   * Present (even when empty) means the app-resource branch: these are seeded before the inline
   * keys INSTEAD of the model shape, so the child inherits the parent resource's computed keys
   * rather than inventing model columns the parent never emits. Undefined keeps the model-shape
   * path (a vendor base like `JsonResource`). */
  parentFields?: Record<string, MergedField>;
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
 * 2. Related-model attribute → the real leaf type via the relation's dumped metadata, else
 *    a degrade + warning (never a name-based guess).
 * 3. Metadata leaf type via the field's source column (a cast wins over the raw column).
 * 4. Undecidable field → the strict-mode fallback (`unknown`) or `any`, plus a warning.
 * 5. Otherwise the static type.
 */
export function mergeResourceFields(options: MergeResourceOptions): Record<string, MergedField> {
  const { resourceName, model, staticFields, metadata, annotations, strict, knownEnums, enumNames, warnings } = options;
  const propertyShapes = options.propertyShapes ?? {};
  const propertyTypes = options.propertyTypes ?? {};

  const meta = metadata[model];
  const columns = new Map<string, ColumnMeta>((meta?.columns ?? []).map((c) => [c.name, c]));
  const casts = meta?.casts ?? {};

  /** Resolve an attribute to its TypeScript leaf type against a given column/cast set (cast
   * beats raw column, nullability composed). Returns `'unresolved'` for a class cast that
   * isn't a known ferry enum, or null when the attribute has no metadata at all. */
  const resolveAttr = (
    cols: Map<string, ColumnMeta>,
    castMap: Record<string, string>,
    attr: string
  ): string | 'unresolved' | null => {
    const col = cols.get(attr);
    const nullable = col?.nullable ?? false;
    if (castMap[attr] !== undefined) {
      const resolved = resolveCast(castMap[attr], knownEnums);
      if (resolved.unresolved) return 'unresolved';
      if (resolved.enum) enumNames.add(resolved.enum);
      return nullable ? `${resolved.type} | null` : resolved.type;
    }
    if (col) return mapColumnType(col.type_name, col.nullable);
    return null;
  };

  /** Resolve one of the resource's own columns through the model's metadata. */
  const resolveLeaf = (columnName: string): string | 'unresolved' | null => resolveAttr(columns, casts, columnName);

  /** Apply the field's leaf-type modifiers: strip a nullable, add a nullable from a source
   * column, then union in a `when()` default. Order matters — stripNull clears the `| null`
   * a `whenNotNull` column would otherwise carry before any default is unioned on. The
   * default's addend is resolved by the caller (a column-valued default goes through the
   * metadata dump), passed in as `unionAddend`. */
  const finalize = (type: string, info: ResourceFieldInfo, unionAddend?: string): string => {
    let out = type;
    if (info.stripNull) {
      out = out
        .split('|')
        .map((p) => p.trim())
        .filter((p) => p && p !== 'null')
        .join(' | ');
    }
    if (info.nullFromColumn && columns.get(info.nullFromColumn)?.nullable) {
      out = `${out} | null`;
    }
    if (unionAddend) {
      out = normalizeUnion(`${out} | ${unionAddend}`);
    }
    return out;
  };

  /** A documented `@property array{...}` object shape refines the bare `any[]` an
   * array/json/collection cast (or a json column) resolves to, keeping any `| null`. Keyed by
   * the SOURCE model attribute (`info.column`), matching how `propertyShapes` is keyed and the
   * offline path's lookup — so a renamed field (`'prefs' => $this->settings`) still resolves.
   * Attributes with no documented shape are untouched, so a plain array cast stays `any[]`. */
  const refineArrayShape = (leaf: string, attribute: string): string => {
    const shape = propertyShapes[attribute];
    if (!shape) return leaf;
    const parts = leaf.split('|').map((p) => p.trim());
    if (parts[0] !== 'any[]') return leaf;
    parts[0] = shape;
    return parts.join(' | ');
  };

  const degrade = (field: string, optional: boolean): MergedField => {
    const fallback = strict ? 'unknown' : 'any';
    warnings.push(
      `${resourceName}.${field} could not be resolved statically; typed as \`${fallback}\`. ` +
        `Add \`@ferry ${field} <TS type>\` to toArray()'s docblock to pin it.`
    );
    return { type: fallback, optional };
  };

  const out: Record<string, MergedField> = {};

  // Parent contribution of `array_merge(parent::toArray(...), [...])` when the resource extends an
  // app-local Resource: the parent resource's own resolved `toArray` shape (its computed keys, its
  // pins, its own chain — already resolved through this same pipeline). Seeded BEFORE the inline
  // loop so inline keys override on collision; the model shape is NOT consulted, so columns the
  // parent resource never emits don't leak in. `parentFields` present (even empty) selects this
  // path; empty means the parent file was missing/unreadable/cyclic — degrade to inline-only.
  if (options.parentFields !== undefined) {
    Object.assign(out, options.parentFields);
  } else if (options.mergesParent && meta) {
    seedModelShape();
  }

  // Model-shape seeding for the vendor-base case (`extends JsonResource` + `@mixin`): the model's
  // serialized shape — every column minus `$hidden` (typed by cast-or-column), plus each
  // `$appends` accessor (typed by the model's scalar `@property` docblock). A `$visible` whitelist,
  // when the model sets one, restricts serialization to just those attributes. Relations are
  // excluded — only-when-loaded, not statically knowable. Seeded BEFORE the inline loop so inline
  // keys override parent keys on collision (PHP array_merge, inline array last); a `@ferry` pin
  // still wins over both.
  function seedModelShape(): void {
    const hidden = new Set(meta!.hidden ?? []);
    const visible = meta!.visible ?? [];
    const visibleSet = visible.length > 0 ? new Set(visible) : null;
    const serialized = (attr: string) => !hidden.has(attr) && (!visibleSet || visibleSet.has(attr));

    for (const col of meta!.columns) {
      if (!serialized(col.name)) continue;
      if (annotations[col.name] !== undefined) {
        out[col.name] = { type: rewriteEnumPin(annotations[col.name], knownEnums), optional: false };
        continue;
      }
      const leaf = resolveLeaf(col.name);
      if (leaf === 'unresolved' || leaf === null) {
        out[col.name] = degrade(col.name, false);
        continue;
      }
      out[col.name] = { type: refineArrayShape(leaf, col.name), optional: false };
    }

    for (const append of meta!.appends ?? []) {
      if (!serialized(append)) continue;
      if (annotations[append] !== undefined) {
        out[append] = { type: rewriteEnumPin(annotations[append], knownEnums), optional: false };
        continue;
      }
      const documented = propertyTypes[append];
      // An undocumented append can't be typed — degrade with the same warning pattern.
      out[append] = documented ? { type: documented, optional: false } : degrade(append, false);
    }
  }

  for (const [field, info] of Object.entries(staticFields)) {
    const optional = info.optional;

    // 1. Annotation override — emitted verbatim, clears any warning. A bare known-enum name in
    // the pin text is rewritten to its `<Enum>Value` backing-value union.
    if (annotations[field] !== undefined) {
      out[field] = { type: rewriteEnumPin(annotations[field], knownEnums), optional };
      continue;
    }

    // Resolve a `when()` default's union addend. A column-valued default goes through the
    // same metadata path as the value; an unresolvable class-cast default degrades the whole
    // field, and a column with no metadata falls back to its static type.
    let unionAddend = info.unionWith;
    if (info.unionWithColumn) {
      const leaf = resolveLeaf(info.unionWithColumn);
      if (leaf === 'unresolved') {
        out[field] = degrade(field, optional);
        continue;
      }
      if (leaf !== null) unionAddend = leaf;
    }

    // 2. Related-model attribute (`$this->author->name`): resolve its real leaf type through
    //    the relation's dumped metadata. Never a name-based guess — degrade with a warning
    //    when the relation wasn't dumped or the attribute isn't a real column/cast on it.
    if (info.relation && info.attribute) {
      const relMeta = meta?.relations?.[info.relation];
      if (relMeta) {
        const relCols = new Map<string, ColumnMeta>(relMeta.columns.map((c) => [c.name, c]));
        const leaf = resolveAttr(relCols, relMeta.casts, info.attribute);
        if (leaf !== null && leaf !== 'unresolved') {
          out[field] = { type: finalize(leaf, info, unionAddend), optional };
          continue;
        }
      }
      out[field] = degrade(field, optional);
      continue;
    }

    // 3. Metadata leaf type via the source column (cast beats column type). Nullability
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
        const leaf = refineArrayShape(nullable ? `${resolved.type} | null` : resolved.type, column);
        out[field] = { type: finalize(leaf, info, unionAddend), optional };
        continue;
      }
      if (col) {
        const leaf = refineArrayShape(mapColumnType(col.type_name, col.nullable), column);
        out[field] = { type: finalize(leaf, info, unionAddend), optional };
        continue;
      }
    }

    // 4. Undecidable field — degrade instead of failing the build.
    if (info.undecidable) {
      out[field] = degrade(field, optional);
      continue;
    }

    // A `Resource::collection(...)` argument that looked like it could be a paginator but
    // couldn't be resolved statically: keep the `Item[]` type (no silent mistype either way)
    // and warn instead of degrading.
    if (info.paginatorUnresolved) {
      warnings.push(
        `${resourceName}.${field}: Resource::collection() argument's paginator kind (paginate/simplePaginate/cursorPaginate) ` +
          `could not be resolved statically; typed as \`${info.type}\`. If this is actually a paginator, ` +
          `it will mistype unless the argument's method chain ends in one of those three calls.`
      );
    }

    // 5. Static type (includes enum names resolved from static casts).
    out[field] = { type: finalize(info.type, info, unionAddend), optional };
  }

  // On the app-resource path, a child `@ferry` pin create-or-overrides a seeded parent key even
  // when the child never names it inline — matching the shared-props side, where pins win over
  // inherited fields. (The vendor model-shape path applies pins inline above; nothing to add.)
  if (options.parentFields !== undefined) {
    for (const [field, type] of Object.entries(annotations)) {
      out[field] = { type: rewriteEnumPin(type, knownEnums), optional: out[field]?.optional ?? false };
    }
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

  const byClassName = new Map<string, ResourceInput>();
  for (const input of inputs) byClassName.set(input.className, input);

  // Resolved fields memoized by class name, so an ancestor shared by several descendants resolves
  // — and pushes any degrade warning — exactly once, not once per descendant plus standalone.
  const cache = new Map<string, Record<string, MergedField>>();

  // Resolve one resource's fields, following an app-local `extends` parent through this same merge
  // so the parent's own `@mixin`/pins/`extends` chain resolve too. The parent is app-local iff it
  // was collected into `byClassName` (collection is recursive and keyed by short name, so a parent
  // in a subdirectory still matches); a vendor base like `JsonResource` is never collected, so it
  // stays undefined → model-shape seeding. An app parent that's unanalyzable or cyclic yields `{}`
  // — inline-only, but still off the model-shape path. `seen` guards cycles (A extends B extends A).
  const resolveFields = (input: ResourceInput, seen: Set<string>): Record<string, MergedField> => {
    const cached = cache.get(input.className);
    if (cached) return cached;

    let parentFields: Record<string, MergedField> | undefined;
    if (input.mergesParent && input.parentResource && byClassName.has(input.parentResource)) {
      const parent = byClassName.get(input.parentResource);
      if (parent?.staticFields && !seen.has(input.parentResource)) {
        seen.add(input.parentResource);
        parentFields = resolveFields(parent, seen);
      } else {
        parentFields = {};
      }
    }

    const fields = mergeResourceFields({
      resourceName: input.className,
      model: input.model,
      staticFields: input.staticFields as Record<string, ResourceFieldInfo>,
      metadata,
      annotations: input.annotations,
      propertyShapes: input.propertyShapes,
      propertyTypes: input.propertyTypes,
      mergesParent: input.mergesParent,
      parentFields,
      strict,
      knownEnums,
      enumNames,
      warnings,
    });

    cache.set(input.className, fields);
    return fields;
  };

  for (const input of inputs) {
    for (const name of input.enumNames) enumNames.add(name);

    if (!input.staticFields) {
      resources[input.className] = { kind: 'fallback', record: fallbackRecord };
      warnings.push(
        `${input.className}: could not statically analyze toArray(); typed as \`Record<string, ${fallbackRecord}>\`.`
      );
      continue;
    }

    resources[input.className] = { kind: 'shape', fields: resolveFields(input, new Set([input.className])) };
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

/**
 * Rewrite a `@ferry` pin's type text so a bare known-enum name resolves to its backing-value
 * union — a pin describes the JSON the frontend receives, where a serialized enum is always its
 * backing value. `\bName\b` never matches inside `NameValue`, so an explicit `<Enum>Value` pin is
 * never double-suffixed and an overlapping shorter name (`Order`) never matches inside a longer
 * one (`OrderStatus`); the rewrite is therefore order-independent across `knownEnums`. A name
 * inside a quoted string-literal type (`'OrderStatus'`) is left alone — only a bare identifier is
 * rewritten. Applied only to human-written pin text, never to auto-resolved field types.
 */
function rewriteEnumPin(type: string, knownEnums: Set<string>): string {
  let result = type;
  for (const enumName of knownEnums) {
    result = result.replace(
      new RegExp(`(?<!['"\`])\\b${escapeRegExp(enumName)}\\b(?!['"\`])`, 'g'),
      `${enumName}Value`
    );
  }
  return result;
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

  const lines = fields.map(([key, field]) => `  ${renderKey(key)}${field.optional ? '?' : ''}: ${field.type};`);
  return [`export type ${name} = {`, ...lines, `};`].join('\n');
}

/**
 * The `declare module '@ferry/resources'` block for the ambient `index.d.ts`. Any
 * referenced enum is imported from `@ferry/enums` at the top of the block — the import
 * is block-scoped, so it does NOT flip the ambient file to module mode (the same pattern
 * the enums block uses to import the base `Enum`).
 */
export function generateResourcesDtsBlock(
  resources: Record<string, ResourceEntry>,
  enumNames: Set<string>,
  knownEnums: Set<string> = new Set()
): string {
  const names = Object.keys(resources).sort();
  if (names.length === 0) {
    return `declare module '${RESOURCES_MODULE_ID}' {}`;
  }

  // Only import the `<Enum>Value` types actually referenced by a rendered field type. This
  // covers both auto-resolved enum casts (`enumNames`) and `@ferry` pins whose text names a
  // generated backing-value union (`knownEnums`); a pin never populates `enumNames`, so
  // scanning against every known enum is what keeps a pinned `<Enum>Value` from silently
  // resolving to `any`.
  const scanEnums = new Set([...enumNames, ...knownEnums]);
  const used = new Set<string>();
  const usedPagination = new Set<string>();
  for (const name of names) {
    const entry = resources[name];
    if (entry.kind !== 'shape') continue;
    for (const field of Object.values(entry.fields)) {
      for (const enumName of scanEnums) {
        if (typeContainsName(field.type, `${enumName}Value`)) used.add(`${enumName}Value`);
      }
      for (const envelope of PAGINATION_ENVELOPE_TYPES) {
        if (typeContainsName(field.type, envelope)) usedPagination.add(envelope);
      }
    }
  }

  const parts: string[] = [];
  if (used.size > 0) {
    parts.push(`import { ${[...used].sort().join(', ')} } from '${ENUMS_MODULE_ID}';`);
    parts.push('');
  }
  if (usedPagination.size > 0) {
    parts.push(`import type { ${[...usedPagination].sort().join(', ')} } from '${PAGINATION_MODULE_ID}';`);
    parts.push('');
  }
  parts.push(names.map((name) => renderResourceType(name, resources[name])).join('\n\n'));

  const inner = parts.join('\n');
  return `declare module '${RESOURCES_MODULE_ID}' {\n${indentBlock(inner)}\n}`;
}

// ---------------------------------------------------------------------------
// Collection + metadata dump (file I/O + PHP)
// ---------------------------------------------------------------------------

/**
 * Read the backing model's class-level `@property array{...} $field` object shapes and map
 * each to a TS object literal, keyed by field. Empty when the model file is absent or
 * documents no such shapes.
 */
function readModelPropertyShapes(modelsDir: string, model: string): Record<string, string> {
  if (!modelsDir || !model) return {};
  const modelPath = join(modelsDir, `${model}.php`);
  if (!existsSync(modelPath)) return {};
  const content = readFileSafe(modelPath);
  if (!content) return {};

  const shapes = parseModelPropertyShapes(content);
  const mapped: Record<string, string> = {};
  for (const [field, shape] of Object.entries(shapes)) {
    mapped[field] = mapDocTypeToTs(shape);
  }
  return mapped;
}

/**
 * Read the backing model's scalar `@property`/`@property-read` types and map each to a TS type,
 * keyed by name. Used to type the model's `$appends` accessors when a resource merges the
 * parent. Empty when the model file is absent or documents no scalar properties.
 */
function readModelPropertyTypes(modelsDir: string, model: string): Record<string, string> {
  if (!modelsDir || !model) return {};
  const modelPath = join(modelsDir, `${model}.php`);
  if (!existsSync(modelPath)) return {};
  const content = readFileSafe(modelPath);
  if (!content) return {};

  const types = parseModelPropertyTypes(content);
  const mapped: Record<string, string> = {};
  for (const [name, docType] of Object.entries(types)) {
    mapped[name] = mapDocTypeToTs(docType);
  }
  return mapped;
}

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
 * the `php-parser` static pass — no PHP process. Recurses into subdirectories so nested
 * resources are collected, matching page generation (which scans controllers recursively);
 * otherwise a nested resource could be imported by `@ferry/pages` yet never exported here.
 *
 * Resources are keyed by their short class name, so two classes with the same short name in
 * different namespaces collide. Default: first-wins with a warning naming both files. Under
 * `strict`, the collision hard-fails the build instead.
 */
export function collectResourceInputs(options: {
  resourcesDir: string;
  modelsDir: string;
  enumsDir: string;
  cwd: string;
  strict?: boolean;
}): ResourceInput[] {
  const { resourcesDir, modelsDir, enumsDir, cwd, strict = false } = options;

  if (!existsSync(resourcesDir)) {
    return [];
  }

  const inputs: ResourceInput[] = [];
  const seen = new Map<string, string>();

  for (const filePath of getPhpFilesRecursive(resourcesDir)) {
    const className = parse(filePath).name;
    const relativePhpPath = relative(cwd, filePath);

    // Duplicate short class name across namespaces — checked before parsing so a strict
    // failure propagates rather than being swallowed by the per-file parse guard below.
    const firstPath = seen.get(className);
    if (firstPath !== undefined) {
      const message = `Duplicate resource class name '${className}': ${relative(cwd, firstPath)} and ${relativePhpPath}`;
      if (strict) {
        throw new Error(`${message}. Rename one, or disable strict mode to keep the first.`);
      }
      logWarn('resources', `${message}. Keeping the first; ignoring ${relativePhpPath}.`);
      continue;
    }
    seen.set(className, filePath);

    try {
      const content = readFileSafe(filePath) || '';

      const collectedEnums: Record<string, EnumDefinition> = {};
      const docShape = extractDocblockArrayShape(content);
      const mappedDocShape = docShape ? mapDocShape(docShape) : null;

      // The backing model: the `@mixin` docblock when present, else the naming convention.
      const model = extractMixinModel(content) ?? className.replace(/Resource$/, '');

      // Class-level `@property array{...}` object shapes on the model refine an
      // array/json/collection cast's bare `any[]` into the documented object literal.
      const propertyShapes = readModelPropertyShapes(modelsDir, model);

      // Scalar `@property` types on the model type its `$appends` accessors when the resource
      // merges the parent (`array_merge(parent::toArray(...), [...])`).
      const propertyTypes = readModelPropertyTypes(modelsDir, model);
      const mergesParent = resourceMergesParent(content);
      const parentResource = extractExtendsShortName(content) ?? undefined;

      const staticFields = parseResourceFieldsAst(content, {
        resourcesDir,
        modelsDir,
        enumsDir,
        docShape: mappedDocShape,
        collectedEnums,
        modelName: model,
        filePath: relativePhpPath,
      });

      inputs.push({
        className,
        model,
        staticFields,
        annotations: extractFerryAnnotations(content),
        propertyShapes,
        propertyTypes,
        mergesParent,
        parentResource,
        enumNames: Object.keys(collectedEnums),
      });
    } catch (e) {
      logWarn('resources', `Failed to parse resource file: ${relativePhpPath} (${e})`);
    }
  }

  return inputs;
}

/**
 * Build the PHP dump script. A temp file (rather than a giant inline `--execute`
 * string) keeps the multi-statement expression off the shell command line, where its
 * quoting is fragile; tinker just `require`s it. Each model is guarded independently so
 * a missing class or table skips that model instead of aborting the whole dump.
 *
 * `relationsByModel` names the relations each model reads through (`$this->rel->attr`),
 * keyed by the model's short name. For each, the script walks the relation method to its
 * related model and dumps that model's columns/casts, so the merge can type the attribute
 * from the real related schema. Each relation is guarded independently — a relation that
 * can't be instantiated is skipped, and the merge degrades that field with a warning.
 * Output is wrapped in sentinels so tinker's own banner/echo can be stripped.
 */
function buildDumpScript(modelClasses: string[], relationsByModel: Record<string, string[]> = {}): string {
  const list = modelClasses.map((c) => `'${c.replace(/\\/g, '\\\\')}'`).join(', ');
  const relEntries = Object.entries(relationsByModel)
    .filter(([, rels]) => rels.length > 0)
    .map(([model, rels]) => `'${model}' => [${rels.map((r) => `'${r}'`).join(', ')}]`)
    .join(', ');
  return [
    '<?php',
    '$ferryOut = [];',
    `$ferryModels = [${list}];`,
    `$ferryRelations = [${relEntries}];`,
    'foreach ($ferryModels as $ferryClass) {',
    '    if (!class_exists($ferryClass)) { continue; }',
    '    try {',
    '        $ferryModel = new $ferryClass();',
    '        $ferryShort = class_basename($ferryClass);',
    '        $ferryTable = $ferryModel->getTable();',
    '        $ferryRelOut = [];',
    '        foreach ($ferryRelations[$ferryShort] ?? [] as $ferryRel) {',
    '            try {',
    '                if (!method_exists($ferryModel, $ferryRel)) { continue; }',
    '                $ferryRelation = $ferryModel->{$ferryRel}();',
    '                if (!($ferryRelation instanceof \\Illuminate\\Database\\Eloquent\\Relations\\Relation)) { continue; }',
    '                $ferryRelated = $ferryRelation->getRelated();',
    '                $ferryRelOut[$ferryRel] = [',
    "                    'columns' => \\Illuminate\\Support\\Facades\\Schema::getColumns($ferryRelated->getTable()),",
    "                    'casts' => $ferryRelated->getCasts(),",
    '                ];',
    '            } catch (\\Throwable $ferryRelErr) { continue; }',
    '        }',
    '        $ferryOut[$ferryShort] = [',
    "            'table' => $ferryTable,",
    "            'columns' => \\Illuminate\\Support\\Facades\\Schema::getColumns($ferryTable),",
    "            'casts' => $ferryModel->getCasts(),",
    "            'relations' => $ferryRelOut,",
    "            'appends' => $ferryModel->getAppends(),",
    "            'hidden' => $ferryModel->getHidden(),",
    "            'visible' => $ferryModel->getVisible(),",
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
export function dumpMetadata(
  cwd: string,
  models: string[],
  relationsByModel: Record<string, string[]> = {}
): MetadataDump {
  if (models.length === 0) return {};

  const script = buildDumpScript(
    models.map((m) => `App\\Models\\${m}`),
    relationsByModel
  );
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
export function registerResources({
  resourcesDir,
  modelsDir,
  cwd,
  delivery,
  strict = false,
}: ResourceRegisterOptions): void {
  const enumsDir = join(cwd, 'app/Enums');

  const inputs = collectResourceInputs({ resourcesDir, modelsDir, enumsDir, cwd, strict });
  const models = [...new Set(inputs.map((i) => i.model))].filter(Boolean);

  // The relations each model reads through (`$this->rel->attr`), so the dump can walk them
  // to the related model and type the attribute from its real schema.
  const relationsByModel: Record<string, string[]> = {};
  for (const input of inputs) {
    if (!input.model || !input.staticFields) continue;
    const rels = relationsByModel[input.model] ?? (relationsByModel[input.model] = []);
    for (const info of Object.values(input.staticFields)) {
      if (info.relation && !rels.includes(info.relation)) rels.push(info.relation);
    }
  }

  const metadata = dumpMetadata(cwd, models, relationsByModel);

  // The enums ferry actually generates into `@ferry/enums`. A metadata cast is only
  // treated as an enum reference when its class short name is in this set.
  const knownEnums = new Set(Object.keys(collectEnums(enumsDir, cwd)));

  const { resources, enumNames, warnings } = buildResources(inputs, metadata, strict, knownEnums);
  for (const warning of warnings) logWarn('resources', warning);

  delivery.virtual.register(RESOURCES_MODULE_ID, RESOURCE_RUNTIME);
  delivery.dts.register(RESOURCES_MODULE_ID, generateResourcesDtsBlock(resources, enumNames, knownEnums));
}
