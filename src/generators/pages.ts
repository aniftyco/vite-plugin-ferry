import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Delivery } from '../delivery/index.js';
import { logWarn } from '../utils/banner.js';
import { getPhpFilesRecursive, readFileSafe } from '../utils/file.js';
import { renderKey } from '../utils/ts-keys.js';
import {
  parsePhp,
  findAllNodesByKind,
  findNodeByKind,
  inferTypeFromAstNode,
  closureReturnExpression,
  getNodeStringValue,
  extractFerryAnnotations,
  type ResourceFieldInfo,
} from '../utils/php-parser.js';
import { collectEnums } from './enums.js';

/** The ferry virtual/type module id per-page prop types are delivered under. */
export const PAGES_MODULE_ID = '@ferry/pages';

/** The module resource types are imported from inside the generated blocks. */
const RESOURCES_MODULE_ID = '@ferry/resources';

/** The module enum types are imported from inside the generated blocks. */
const ENUMS_MODULE_ID = '@ferry/enums';

/** The separate module-style file carrying the `@inertiajs/core` augmentation. */
export const INERTIA_AUGMENTATION_FILE = 'inertia.d.ts';

/** Pages are type-only, so the virtual module has no runtime — just a valid empty module. */
export const PAGES_RUNTIME = 'export {};\n';

/** Laravel's validation error value: each field maps to its first error message. */
const ERROR_VALUE_TYPE = 'string';

/** A resolved prop: its TypeScript type and whether the key is optional. */
export type PropField = {
  type: string;
  optional: boolean;
};

/** One `Inertia::render(...)` result: a page key and the shape it renders. */
export type RenderInput = {
  key: string;
  fields: Record<string, ResourceFieldInfo>;
};

/** The shared-data shape from `HandleInertiaRequests::share()`. */
export type SharedInput = {
  fields: Record<string, ResourceFieldInfo>;
};

export type PageRegisterOptions = {
  controllersDir: string;
  middlewareDir: string;
  resourcesDir: string;
  modelsDir: string;
  cwd: string;
  delivery: Delivery;
  /** Fallback type for undecidable props: `false` → `any` (default), `true` → `unknown`. */
  strict?: boolean;
};

// ---------------------------------------------------------------------------
// Page-key ↔ type-name mapping
// ---------------------------------------------------------------------------

/** Capitalize the first character of a word. */
function cap(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);
}

/**
 * Map an Inertia page key to an identifier-safe props type name. Path separators and
 * `-`/`_`/space delimiters split segments that are PascalCased and concatenated, then
 * suffixed `Props`: `'Users/Show'` → `UsersShowProps`, `'users/show'` → `UsersShowProps`.
 */
export function pageKeyToTypeName(key: string): string {
  const parts = key
    .split(/[\/\\]/)
    .flatMap((segment) => segment.split(/[-_ ]/))
    .map(cap)
    .join('');
  return `${parts.replace(/[^A-Za-z0-9]/g, '')}Props`;
}

// ---------------------------------------------------------------------------
// PHP prop-value inference (reuses the resource machinery)
// ---------------------------------------------------------------------------

type InferOptions = {
  resourcesDir: string;
  modelsDir: string;
  enumsDir: string;
  knownEnums: Set<string>;
};

/** The basename of a possibly-namespaced PHP name (`App\Enums\OrderStatus` → `OrderStatus`). */
function shortName(name: string): string {
  return name.replace(/^\\+/, '').split('\\').pop() ?? name;
}

/** A bare enum-case reference (`OrderStatus::PENDING`), returning the enum short name if known. */
function enumCaseReference(node: any, knownEnums: Set<string>): string | null {
  if (!node || node.kind !== 'staticlookup') return null;
  if (node.what?.kind !== 'name') return null;
  const offsetName = node.offset?.kind === 'identifier' ? node.offset.name : null;
  // `Foo::class` is not an enum case; enum cases are `Foo::CASE`.
  if (!offsetName || offsetName === 'class') return null;
  const enumName = shortName(node.what.name);
  return knownEnums.has(enumName) ? enumName : null;
}

/**
 * Infer a prop value's TypeScript type. Handles the cases the resource machinery does
 * not cover in a controller context — enum-case references and scalar literals — then
 * delegates everything else (resource `make`/`collection`/`new`, undecidable expressions)
 * to the shared resource inference, so both pillars agree on how a value becomes a type.
 */
export function inferPropType(node: any, key: string, options: InferOptions): ResourceFieldInfo {
  const { resourcesDir, modelsDir, enumsDir, knownEnums } = options;

  if (!node) return { type: 'any', optional: false, undecidable: true };

  // Enum-case reference → the ferry enum type.
  const enumRef = enumCaseReference(node, knownEnums);
  if (enumRef) return { type: enumRef, optional: false };

  // Scalar literals.
  if (node.kind === 'string') return { type: 'string', optional: false };
  if (node.kind === 'number') return { type: 'number', optional: false };
  if (node.kind === 'boolean') return { type: 'boolean', optional: false };
  if (node.kind === 'nullkeyword') return { type: 'null', optional: false };

  // Ternary: union the resolvable branches, folding in `null` for a null branch.
  if (node.kind === 'retif') {
    const branches = [node.trueExpr ?? node.test, node.falseExpr]
      .filter((b: any) => b != null)
      .map((b: any) => inferPropType(b, key, options));
    const types = [...new Set(branches.map((b) => b.type))];
    if (!branches.some((b) => b.undecidable)) {
      return { type: types.join(' | '), optional: false };
    }
  }

  // Keyed array → an inline object shape; list array → any[].
  if (node.kind === 'array') {
    const nested = parseEntries(node.items ?? [], options);
    const keys = Object.keys(nested);
    if (keys.length > 0) {
      const props = keys.map((k) => `${renderKey(k)}${nested[k].optional ? '?' : ''}: ${nested[k].type}`);
      return { type: `{ ${props.join('; ')} }`, optional: false };
    }
    return { type: 'any[]', optional: false };
  }

  // A bare closure prop (`'x' => fn () => <expr>` / `function () { return <expr>; }`).
  // Inertia always evaluates and sends these, so the prop stays required; its type is the
  // closure's returned expression, resolved through the same inference.
  if (node.kind === 'arrowfunc' || node.kind === 'closure') {
    const returned = closureReturnExpression(node);
    if (returned) return inferPropType(returned, key, options);
    return { type: 'any', optional: false, undecidable: true };
  }

  // Inertia partial-reload wrappers (`Inertia::defer|lazy|optional|merge(...)`): resolve the
  // inner value's type. `defer`/`lazy`/`optional` are omitted on initial load, so the honest
  // key is optional; `merge` props are present on load, so the key stays required.
  const wrapper = inertiaWrapper(node);
  if (wrapper) {
    const info = inferPropType(wrapper.inner, key, options);
    return { ...info, optional: wrapper.optional || info.optional };
  }

  // Everything else → the shared resource inference (resource refs, key heuristics,
  // undecidable → degrade signal).
  return inferTypeFromAstNode(node, key, { resourcesDir, modelsDir, enumsDir });
}

/**
 * Detect an Inertia partial-reload wrapper (`Inertia::defer|lazy|optional|merge(...)`) and
 * return the inner value node to resolve plus whether the prop is optional. `defer`/`lazy`/
 * `optional` take a closure and are omitted on initial load (optional); `merge` takes a value
 * or closure and is present on load (required). Returns null for anything else — including an
 * `defer`/`lazy`/`optional` call whose argument isn't a closure ferry can read — so the caller
 * falls back to the existing behavior.
 */
function inertiaWrapper(node: any): { inner: any; optional: boolean } | null {
  if (!node || node.kind !== 'call') return null;

  const what = node.what;
  if (what?.kind !== 'staticlookup' || what.what?.kind !== 'name') return null;
  if (shortName(what.what.name) !== 'Inertia') return null;

  const method = what.offset?.kind === 'identifier' ? what.offset.name : null;
  const args = node.arguments ?? [];
  if (!method || args.length === 0) return null;

  if (method === 'defer' || method === 'lazy' || method === 'optional') {
    const returned = closureReturnExpression(args[0]);
    return returned ? { inner: returned, optional: true } : null;
  }

  if (method === 'merge') {
    const returned = closureReturnExpression(args[0]);
    return { inner: returned ?? args[0], optional: false };
  }

  return null;
}

/** Infer the shape of a keyed PHP array's entries. */
function parseEntries(items: any[], options: InferOptions): Record<string, ResourceFieldInfo> {
  const fields: Record<string, ResourceFieldInfo> = {};
  for (const item of items) {
    if (!item || item.kind !== 'entry' || !item.key) continue;
    const key = getNodeStringValue(item.key);
    if (!key) continue;
    fields[key] = inferPropType(item.value, key, options);
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Controller + middleware analysis
// ---------------------------------------------------------------------------

/** An `Inertia::render(...)` call (also matches the `inertia(...)` helper). */
function extractRenderArgs(node: any): { key: string; propsNode: any } | null {
  if (!node || node.kind !== 'call') return null;

  const what = node.what;
  // Inertia::render('Page', [...])
  if (what?.kind === 'staticlookup' && what.what?.kind === 'name') {
    const cls = shortName(what.what.name);
    const method = what.offset?.kind === 'identifier' ? what.offset.name : null;
    if (cls !== 'Inertia' || method !== 'render') return null;
  } else if (what?.kind === 'name' && what.name === 'inertia') {
    // inertia('Page', [...])
  } else {
    return null;
  }

  const args = node.arguments ?? [];
  const keyNode = args[0];
  if (!keyNode || keyNode.kind !== 'string') return null;
  const key = getNodeStringValue(keyNode);
  if (!key) return null;

  return { key, propsNode: args[1] ?? null };
}

/** Read a PHP method's leading docblock as text for `@ferry` annotation extraction. */
function methodDocText(method: any): string {
  const comments = method.leadingComments ?? [];
  return comments.map((c: any) => c.value ?? '').join('\n');
}

/**
 * Read every controller file and collect one render input per `Inertia::render(...)`.
 * Pure file I/O plus the `php-parser` static pass — no PHP process. Never throws; an
 * unparseable file is skipped with a warning.
 */
export function collectRenderInputs(options: {
  controllersDir: string;
  resourcesDir: string;
  modelsDir: string;
  enumsDir: string;
  knownEnums: Set<string>;
}): RenderInput[] {
  const { controllersDir, resourcesDir, modelsDir, enumsDir, knownEnums } = options;
  const inferOptions: InferOptions = { resourcesDir, modelsDir, enumsDir, knownEnums };

  const inputs: RenderInput[] = [];

  for (const filePath of getPhpFilesRecursive(controllersDir)) {
    try {
      const content = readFileSafe(filePath) || '';
      const ast = parsePhp(content);
      if (!ast) continue;

      const classNode = findNodeByKind(ast, 'class');
      if (!classNode) continue;

      const methods = findAllNodesByKind(classNode, 'method') as any[];
      for (const method of methods) {
        if (!method.body) continue;
        const annotations = extractFerryAnnotations(methodDocText(method));
        const calls = findAllNodesByKind(method.body, 'call') as any[];

        for (const call of calls) {
          const render = extractRenderArgs(call);
          if (!render) continue;

          const fields =
            render.propsNode && render.propsNode.kind === 'array'
              ? parseEntries(render.propsNode.items ?? [], inferOptions)
              : {};

          // `@ferry <prop> <TS type>` on the action overrides a prop verbatim; a bare known-enum
          // name in the pin text is rewritten to its `<Enum>Value` backing-value union.
          for (const [prop, type] of Object.entries(annotations)) {
            if (fields[prop]) {
              fields[prop] = { ...fields[prop], type: rewriteEnumPin(type, knownEnums), undecidable: false };
            }
          }

          inputs.push({ key: render.key, fields });
        }
      }
    } catch (e) {
      logWarn('pages', `Failed to parse controller file: ${filePath} (${e})`);
    }
  }

  return inputs;
}

/** Find a class node's `share` method, if any. */
function findShareMethod(classNode: any): any {
  return (findAllNodesByKind(classNode, 'method') as any[]).find((m) => {
    const name = typeof m.name === 'string' ? m.name : m.name?.name;
    return name === 'share';
  });
}

/** Whether a `share()` body calls `parent::share(...)`. */
function referencesParentShare(body: any): boolean {
  const lookups = findAllNodesByKind(body, 'staticlookup') as any[];
  return lookups.some(
    (n) =>
      n.what?.kind === 'parentreference' && (n.offset?.kind === 'identifier' ? n.offset.name : null) === 'share'
  );
}

/**
 * Resolve the parent class's own `share()` fields when a child calls `parent::share()`.
 * The parent is located by short name in `middlewareDir` — the same directory + short-name
 * convention resources/models/enums use — so an app-local base middleware resolves and a
 * vendor parent (e.g. Inertia's base `Middleware`, unlocatable in app source) is skipped
 * silently. `seen` guards against re-parsing and cyclic `extends`.
 */
function collectParentShareFields(
  classNode: any,
  middlewareDir: string,
  inferOptions: InferOptions,
  seen: Set<string>
): Record<string, ResourceFieldInfo> {
  const parent = classNode.extends;
  const parentName = parent?.kind === 'name' ? shortName(parent.name) : null;
  if (!parentName) return {};

  const parentPath = join(middlewareDir, `${parentName}.php`);
  if (seen.has(parentPath) || !existsSync(parentPath)) return {};
  seen.add(parentPath);

  const ast = parsePhp(readFileSafe(parentPath) || '');
  if (!ast) return {};
  const parentClass = findNodeByKind(ast, 'class');
  if (!parentClass) return {};

  return collectShareFields(parentClass, middlewareDir, inferOptions, seen);
}

/**
 * Harvest the statically-resolvable shared-data fields from a class's `share()`: the inline
 * array literals (a bare `return [...]`, or the array arguments of an
 * `array_merge(parent::share(...), [...])` call), the parent's own `share()` fields when the
 * body calls `parent::share()`, and the docblock `@ferry <prop> <TS type>` pins. Pins
 * create-or-override a prop verbatim — declaring conditionally-shared props that never
 * resolve statically and clearing degradation on ones that do. On key collisions the child's
 * inline fields and pins take precedence over inherited parent fields.
 */
function collectShareFields(
  classNode: any,
  middlewareDir: string,
  inferOptions: InferOptions,
  seen: Set<string>
): Record<string, ResourceFieldInfo> {
  const method = findShareMethod(classNode);
  if (!method?.body) return {};

  const returnNode = findNodeByKind(method.body, 'return') as any;
  const expr = returnNode?.expr;

  const arrays: any[] =
    expr?.kind === 'array'
      ? [expr]
      : expr?.kind === 'call'
        ? (expr.arguments ?? []).filter((a: any) => a?.kind === 'array')
        : [];

  // Parent fields first, so the child's own inline fields and pins override them.
  const fields: Record<string, ResourceFieldInfo> = {};
  if (referencesParentShare(method.body)) {
    Object.assign(fields, collectParentShareFields(classNode, middlewareDir, inferOptions, seen));
  }

  for (const arr of arrays) {
    Object.assign(fields, parseEntries(arr.items ?? [], inferOptions));
  }

  for (const [prop, rawType] of Object.entries(extractFerryAnnotations(methodDocText(method)))) {
    const type = rewriteEnumPin(rawType, inferOptions.knownEnums);
    fields[prop] = fields[prop]
      ? { ...fields[prop], type, undecidable: false }
      : { type, optional: false, undecidable: false };
  }

  return fields;
}

/**
 * Read `HandleInertiaRequests::share()` and collect the shared-data shape. Handles a direct
 * `return [...]` and `return array_merge(parent::share($request), [...])`, follows
 * `parent::share()` into an app-local base middleware, and applies `@ferry` docblock pins.
 * Absent middleware or method degrades to an empty shape rather than failing the build.
 */
export function collectSharedInput(options: {
  middlewareDir: string;
  resourcesDir: string;
  modelsDir: string;
  enumsDir: string;
  knownEnums: Set<string>;
}): SharedInput {
  const { middlewareDir, resourcesDir, modelsDir, enumsDir, knownEnums } = options;
  const inferOptions: InferOptions = { resourcesDir, modelsDir, enumsDir, knownEnums };

  const filePath = join(middlewareDir, 'HandleInertiaRequests.php');
  if (!existsSync(filePath)) return { fields: {} };

  try {
    const ast = parsePhp(readFileSafe(filePath) || '');
    if (!ast) return { fields: {} };

    const classNode = findNodeByKind(ast, 'class');
    if (!classNode) return { fields: {} };

    const seen = new Set<string>([filePath]);
    return { fields: collectShareFields(classNode, middlewareDir, inferOptions, seen) };
  } catch (e) {
    logWarn('pages', `Failed to parse HandleInertiaRequests: ${e}`);
    return { fields: {} };
  }
}

// ---------------------------------------------------------------------------
// Degradation + shape building
// ---------------------------------------------------------------------------

/** Degrade an undecidable field to the strict-mode fallback, pushing a warning. */
function finalizeFields(
  label: string,
  raw: Record<string, ResourceFieldInfo>,
  strict: boolean,
  warnings: string[]
): Record<string, PropField> {
  const fallback = strict ? 'unknown' : 'any';
  const out: Record<string, PropField> = {};

  for (const [field, info] of Object.entries(raw)) {
    if (info.undecidable) {
      warnings.push(
        `${label}.${field} could not be resolved statically; typed as \`${fallback}\`. ` +
          `Add \`@ferry ${field} <TS type>\` to the action's docblock to pin it.`
      );
      out[field] = { type: fallback, optional: info.optional };
      continue;
    }
    out[field] = { type: info.type, optional: info.optional };
  }

  return out;
}

/** Render a finalized field set as an inline object type. */
function renderShape(fields: Record<string, PropField>): string {
  const entries = Object.entries(fields);
  if (entries.length === 0) return '{}';
  const props = entries.map(([key, field]) => `${renderKey(key)}${field.optional ? '?' : ''}: ${field.type}`);
  return `{ ${props.join('; ')} }`;
}

/** A built page: its type name and the (possibly unioned) rendered type expression. */
export type PageEntry = {
  typeName: string;
  type: string;
};

/** One `FerryPageMap` entry: a verbatim render key and the normalized type name it resolves to. */
export type PageMapEntry = {
  key: string;
  typeName: string;
};

/**
 * Group render inputs by their PROPS TYPE NAME and build one page entry each. The type name
 * normalizes casing — `pageKeyToTypeName` PascalCases every segment, so `'Users/Show'` and
 * `'users/show'` share the one named type `UsersShowProps`. A page rendered from several
 * actions (including distinct render keys that normalize together) merges into the UNION of its
 * distinct render shapes, so the generated block never emits two `export type` declarations
 * under one name (which would be a TS2300 collision). `pageMap` carries every DISTINCT VERBATIM
 * render key — exactly as written in `Inertia::render(...)` — paired with its normalized type
 * name, backing the literal-keyed `FerryPageMap`; two verbatim keys that normalize together both
 * appear, both pointing at the shared type. Warnings for degraded props are collected. Never
 * throws.
 */
export function buildPages(
  inputs: RenderInput[],
  strict: boolean
): { pages: PageEntry[]; pageMap: PageMapEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const byTypeName = new Map<string, string[]>();
  const keyToTypeName = new Map<string, string>();

  for (const input of inputs) {
    const typeName = pageKeyToTypeName(input.key);
    const shape = renderShape(finalizeFields(input.key, input.fields, strict, warnings));
    const shapes = byTypeName.get(typeName) ?? [];
    shapes.push(shape);
    byTypeName.set(typeName, shapes);
    keyToTypeName.set(input.key, typeName);
  }

  const pages: PageEntry[] = [...byTypeName.keys()].sort().map((typeName) => ({
    typeName,
    type: [...new Set(byTypeName.get(typeName)!)].join(' | '),
  }));

  const pageMap: PageMapEntry[] = [...keyToTypeName.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, typeName]) => ({ key, typeName }));

  return { pages, pageMap, warnings };
}

// ---------------------------------------------------------------------------
// d.ts + module-file rendering
// ---------------------------------------------------------------------------

/** Escape a name for use in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether a type string references `name` as a whole identifier. */
function typeReferences(type: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`).test(type);
}

/**
 * Rewrite a `@ferry` pin's type text so a bare known-enum name resolves to its backing-value
 * union — a pin describes the JSON the frontend receives, where a serialized enum is always its
 * backing value. `\bName\b` never matches inside `NameValue`, so an explicit `<Enum>Value` pin is
 * never double-suffixed and an overlapping shorter name never matches inside a longer one; the
 * rewrite is order-independent across `knownEnums`. A name inside a quoted string-literal type
 * (`'OrderStatus'`) is left alone — only a bare identifier is rewritten. Applied ONLY to
 * human-written pin text — never to an auto-resolved enum-case prop, which stays the
 * value-imported enum CLASS name.
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

/** Indent every non-empty line by two spaces. */
function indentBlock(block: string): string {
  return block
    .split('\n')
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join('\n');
}

/**
 * The block-scoped `import` lines for the resource and enum types a set of type strings
 * references. Block-scoped so they do NOT flip the ambient file to module mode — the same
 * pattern the resources block uses.
 */
function referenceImports(types: string[], knownResources: Set<string>, knownEnums: Set<string>): string[] {
  const usedResources = new Set<string>();
  const usedEnums = new Set<string>();
  const usedEnumValues = new Set<string>();

  for (const type of types) {
    for (const name of knownResources) if (typeReferences(type, name)) usedResources.add(name);
    for (const name of knownEnums) {
      // The enum CLASS name is value-imported; its `<Enum>Value` backing-value union is a
      // distinct, type-only import. `\bName\b` never matches inside `NameValue`, so a pin
      // that names only the union would otherwise go unimported and silently degrade to `any`.
      if (typeReferences(type, name)) usedEnums.add(name);
      if (typeReferences(type, `${name}Value`)) usedEnumValues.add(`${name}Value`);
    }
  }

  const lines: string[] = [];
  if (usedResources.size > 0) {
    lines.push(`import type { ${[...usedResources].sort().join(', ')} } from '${RESOURCES_MODULE_ID}';`);
  }
  if (usedEnums.size > 0) {
    lines.push(`import { ${[...usedEnums].sort().join(', ')} } from '${ENUMS_MODULE_ID}';`);
  }
  if (usedEnumValues.size > 0) {
    lines.push(`import type { ${[...usedEnumValues].sort().join(', ')} } from '${ENUMS_MODULE_ID}';`);
  }
  return lines;
}

/**
 * The `declare module '@ferry/pages'` block for the ambient `index.d.ts`: one
 * `export type <Page>Props` per page, plus (when `pageMap` is given) the literal-keyed
 * `FerryPageMap` interface and the `PropsFor<K>` lookup alias — the string-key alternative
 * to importing a named props type. Map values reference the named types declared in the same
 * block, so no extra imports are needed. Referenced resource/enum types are imported inside
 * the block, keeping the ambient file script-style.
 */
export function generatePagesDtsBlock(
  pages: PageEntry[],
  knownResources: Set<string>,
  knownEnums: Set<string>,
  pageMap: PageMapEntry[] = []
): string {
  if (pages.length === 0) {
    return `declare module '${PAGES_MODULE_ID}' {}`;
  }

  const imports = referenceImports(
    pages.map((p) => p.type),
    knownResources,
    knownEnums
  );
  const decls = pages.map((p) => `export type ${p.typeName} = ${p.type};`);

  const mapLines =
    pageMap.length > 0
      ? [
          'export interface FerryPageMap {',
          ...pageMap.map(({ key, typeName }) => `  ${renderKey(key)}: ${typeName};`),
          '}',
          'export type PropsFor<K extends keyof FerryPageMap> = FerryPageMap[K];',
        ]
      : [];

  const body = mapLines.length > 0 ? [...decls, '', ...mapLines] : decls;
  const inner = imports.length > 0 ? [...imports, '', ...body].join('\n') : body.join('\n');
  return `declare module '${PAGES_MODULE_ID}' {\n${indentBlock(inner)}\n}`;
}

/**
 * The separate `@inertiajs/core` augmentation module file. It imports `@inertiajs/core`
 * (a top-level import), so it CANNOT live in the script-style `index.d.ts`; it is emitted
 * as its own file and pulled into the program by a triple-slash reference. Interface
 * merging fills `sharedPageProps` with the `share()` shape and `errorValueType` with
 * Laravel's error value shape. `flashDataType`, `layoutProps`, and `namedLayoutProps` are
 * left to the developer — they are not inferable from the backend.
 */
export function generateInertiaAugmentation(
  shared: Record<string, PropField>,
  knownResources: Set<string>,
  knownEnums: Set<string>
): string {
  const sharedType = renderShape(shared);
  const imports = referenceImports([sharedType], knownResources, knownEnums);

  const header = [`import '@inertiajs/core';`, ...imports].join('\n');

  const body = [
    `declare module '@inertiajs/core' {`,
    `  export interface InertiaConfig {`,
    `    sharedPageProps: ${sharedType};`,
    `    errorValueType: ${ERROR_VALUE_TYPE};`,
    `  }`,
    `}`,
  ].join('\n');

  return `${header}\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Collect page props and shared data, build the per-page types and the `@inertiajs/core`
 * augmentation, and register the `@ferry/pages` runtime (an empty type-only virtual
 * module), its `declare module` d.ts block, and the augmentation module file with the
 * delivery layer. Degradation warnings are logged. Called on every generation pass and on
 * controller/middleware changes in dev. Does not write the ambient file; the caller runs
 * `writeTypes()`.
 */
export function registerPages({
  controllersDir,
  middlewareDir,
  resourcesDir,
  modelsDir,
  cwd,
  delivery,
  strict = false,
}: PageRegisterOptions): void {
  const enumsDir = join(cwd, 'app/Enums');
  const knownEnums = new Set(Object.keys(collectEnums(enumsDir, cwd)));
  const knownResources = new Set(getPhpFilesRecursive(resourcesDir).map((f) => basename(f, '.php')));

  const renderInputs = collectRenderInputs({ controllersDir, resourcesDir, modelsDir, enumsDir, knownEnums });
  const sharedInput = collectSharedInput({ middlewareDir, resourcesDir, modelsDir, enumsDir, knownEnums });

  const { pages, pageMap, warnings } = buildPages(renderInputs, strict);
  const sharedWarnings: string[] = [];
  const sharedFields = finalizeFields('share()', sharedInput.fields, strict, sharedWarnings);

  for (const warning of [...warnings, ...sharedWarnings]) logWarn('pages', warning);

  delivery.virtual.register(PAGES_MODULE_ID, PAGES_RUNTIME);
  delivery.dts.register(PAGES_MODULE_ID, generatePagesDtsBlock(pages, knownResources, knownEnums, pageMap));
  delivery.moduleFiles.register(
    INERTIA_AUGMENTATION_FILE,
    generateInertiaAugmentation(sharedFields, knownResources, knownEnums)
  );
}
