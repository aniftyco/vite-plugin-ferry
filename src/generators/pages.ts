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

  // Everything else → the shared resource inference (resource refs, key heuristics,
  // undecidable → degrade signal).
  return inferTypeFromAstNode(node, key, { resourcesDir, modelsDir, enumsDir });
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

          // `@ferry <prop> <TS type>` on the action overrides a prop verbatim.
          for (const [prop, type] of Object.entries(annotations)) {
            if (fields[prop]) fields[prop] = { ...fields[prop], type, undecidable: false };
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

/**
 * Read `HandleInertiaRequests::share()` and collect the shared-data shape. Handles a
 * direct `return [...]` and `return array_merge(parent::share($request), [...])`. Absent
 * middleware or method degrades to an empty shape rather than failing the build.
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

    const method = (findAllNodesByKind(classNode, 'method') as any[]).find((m) => {
      const name = typeof m.name === 'string' ? m.name : m.name?.name;
      return name === 'share';
    });
    if (!method?.body) return { fields: {} };

    const returnNode = findNodeByKind(method.body, 'return') as any;
    const expr = returnNode?.expr;
    if (!expr) return { fields: {} };

    // Collect the top-level array literals: the return itself, or array arguments to
    // an `array_merge(parent::share(...), [...])` call.
    const arrays: any[] =
      expr.kind === 'array'
        ? [expr]
        : expr.kind === 'call'
          ? (expr.arguments ?? []).filter((a: any) => a?.kind === 'array')
          : [];

    const fields: Record<string, ResourceFieldInfo> = {};
    for (const arr of arrays) {
      Object.assign(fields, parseEntries(arr.items ?? [], inferOptions));
    }

    return { fields };
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

/**
 * Group render inputs by their PROPS TYPE NAME and build one page entry each. A page
 * rendered from several actions — and distinct render keys that normalize to the same
 * type name (`'Users/Show'` and `'users/show'` both → `UsersShowProps`) — merge into the
 * UNION of their distinct render shapes, so the generated block never emits two
 * `export type` declarations under one name (which would be a TS2300 collision). Warnings
 * for degraded props are collected. Never throws.
 */
export function buildPages(inputs: RenderInput[], strict: boolean): { pages: PageEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const byTypeName = new Map<string, string[]>();

  for (const input of inputs) {
    const typeName = pageKeyToTypeName(input.key);
    const shape = renderShape(finalizeFields(input.key, input.fields, strict, warnings));
    const shapes = byTypeName.get(typeName) ?? [];
    shapes.push(shape);
    byTypeName.set(typeName, shapes);
  }

  const pages: PageEntry[] = [...byTypeName.keys()].sort().map((typeName) => ({
    typeName,
    type: [...new Set(byTypeName.get(typeName)!)].join(' | '),
  }));

  return { pages, warnings };
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

  for (const type of types) {
    for (const name of knownResources) if (typeReferences(type, name)) usedResources.add(name);
    for (const name of knownEnums) if (typeReferences(type, name)) usedEnums.add(name);
  }

  const lines: string[] = [];
  if (usedResources.size > 0) {
    lines.push(`import type { ${[...usedResources].sort().join(', ')} } from '${RESOURCES_MODULE_ID}';`);
  }
  if (usedEnums.size > 0) {
    lines.push(`import { ${[...usedEnums].sort().join(', ')} } from '${ENUMS_MODULE_ID}';`);
  }
  return lines;
}

/**
 * The `declare module '@ferry/pages'` block for the ambient `index.d.ts`: one
 * `export type <Page>Props` per page. Referenced resource/enum types are imported inside
 * the block, keeping the ambient file script-style.
 */
export function generatePagesDtsBlock(
  pages: PageEntry[],
  knownResources: Set<string>,
  knownEnums: Set<string>
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

  const inner = imports.length > 0 ? [...imports, '', ...decls].join('\n') : decls.join('\n');
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

  const { pages, warnings } = buildPages(renderInputs, strict);
  const sharedWarnings: string[] = [];
  const sharedFields = finalizeFields('share()', sharedInput.fields, strict, sharedWarnings);

  for (const warning of [...warnings, ...sharedWarnings]) logWarn('pages', warning);

  delivery.virtual.register(PAGES_MODULE_ID, PAGES_RUNTIME);
  delivery.dts.register(PAGES_MODULE_ID, generatePagesDtsBlock(pages, knownResources, knownEnums));
  delivery.moduleFiles.register(
    INERTIA_AUGMENTATION_FILE,
    generateInertiaAugmentation(sharedFields, knownResources, knownEnums)
  );
}
