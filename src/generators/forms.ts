import { existsSync } from 'node:fs';
import { join, parse, relative } from 'node:path';
import type { Delivery } from '../delivery/index.js';
import { logWarn } from '../utils/banner.js';
import { getPhpFilesRecursive, readFileSafe } from '../utils/file.js';
import { extractFerryAnnotations, parseFormRequestRules, type EnumDefinition } from '../utils/php-parser.js';
import { renderKey } from '../utils/ts-keys.js';
import { collectEnums, ENUMS_MODULE_ID } from './enums.js';

/** The ferry virtual/type module id form-data types are delivered under. */
export const FORMS_MODULE_ID = '@ferry/forms';

/** Forms are type-only, so the virtual module has no runtime — just a valid empty module. */
export const FORM_RUNTIME = 'export {};\n';

/** A resolved form field: its TypeScript type and whether the key is optional. */
export type FormField = {
  type: string;
  optional: boolean;
};

/** A form's final shape: a resolved field set, or a fallback when `rules()` couldn't be read. */
export type FormEntry = { kind: 'shape'; fields: Record<string, FormField> } | { kind: 'fallback'; record: string };

/** A form request's static analysis result. */
export type FormInput = {
  className: string;
  /** The `rules()` map (key → tokens), or null when it couldn't be analyzed at all. */
  rules: Record<string, string[]> | null;
  /** `@ferry <field> <type>` docblock pins: field → raw TS type, emitted verbatim. */
  annotations: Record<string, string>;
};

export type FormRegisterOptions = {
  requestsDir: string;
  cwd: string;
  delivery: Delivery;
  /** Fallback type for undecidable fields: `false` → `any` (default), `true` → `unknown`. */
  strict?: boolean;
};

// ---------------------------------------------------------------------------
// Rule token → leaf type
// ---------------------------------------------------------------------------

/** Render an enum backing value as a TS literal: numbers stay numeric, strings get quoted. */
function renderEnumValue(value: string | number): string {
  return typeof value === 'number' ? String(value) : `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Whether a TypeScript type string references `name` as a whole identifier. */
function typeContainsName(type: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(type);
}

/**
 * Resolve a field's rule tokens to a leaf type plus its modifiers. `sometimes` makes the key
 * optional; `nullable` unions `null` onto the value. The first token carrying a type signal
 * wins (`in:` builds a string-literal union). A field with no type signal at all — only
 * modifiers, or only an unmappable `Rule::`/closure item ferry dropped — resolves to `null`,
 * signalling the caller to degrade it.
 */
function resolveTokens(
  tokens: string[],
  enums: Record<string, EnumDefinition>,
  knownEnums: Set<string>
): { type: string | null; optional: boolean; nullable: boolean; enum?: string } {
  const optional = tokens.includes('sometimes');
  const nullable = tokens.includes('nullable');

  for (const token of tokens) {
    const name = token.split(':')[0].trim().toLowerCase();

    if (['string', 'email', 'url', 'uuid', 'date'].includes(name)) return { type: 'string', optional, nullable };
    if (['integer', 'numeric', 'decimal'].includes(name)) return { type: 'number', optional, nullable };
    if (['boolean', 'bool'].includes(name)) return { type: 'boolean', optional, nullable };
    if (name === 'accepted') return { type: 'boolean', optional, nullable };
    // File-upload rules type as the DOM `File` (Inertia `useForm` file fields are `File`).
    // `max` stays a generic constraint and is deliberately not mapped here.
    if (['file', 'image', 'mimes', 'mimetypes', 'dimensions'].includes(name)) {
      return { type: 'File', optional, nullable };
    }
    if (name === 'enum') {
      // `Rule::enum(SomeEnum::class)` — the field submits the raw backing value, so it types
      // as the enum's backing-value union. A known ferry enum resolves to the generated
      // `<Enum>Value` (recorded so the block imports it); a collected-but-not-emitted enum
      // inlines its union; an unresolvable enum falls through to degrade.
      const short = token.slice(token.indexOf(':') + 1).trim();
      if (knownEnums.has(short)) return { type: `${short}Value`, optional, nullable, enum: short };
      const def = enums[short];
      if (def && def.cases.length > 0) {
        return { type: def.cases.map((c) => renderEnumValue(c.value)).join(' | '), optional, nullable };
      }
      continue;
    }
    if (name === 'array') return { type: 'any[]', optional, nullable };
    if (name === 'in') {
      const values = token
        .slice(token.indexOf(':') + 1)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      if (values.length > 0) {
        return { type: values.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(' | '), optional, nullable };
      }
    }
  }

  return { type: null, optional, nullable };
}

// ---------------------------------------------------------------------------
// Dotted / wildcard key → nested shape
// ---------------------------------------------------------------------------

/** A resolved rule field: its dotted key path and leaf info. */
type ResolvedField = { key: string; type: string; optional: boolean; nullable: boolean };

/** A node in the nested-shape tree built from dotted rule keys. */
type TreeNode = {
  children: Map<string, TreeNode>;
  leaf?: { type: string; optional: boolean; nullable: boolean };
};

function newNode(): TreeNode {
  return { children: new Map() };
}

/**
 * Build a nested tree from dotted/wildcard rule keys. `profile.bio` nests `bio` under
 * `profile`; a `*` segment marks its parent as an array (`items.*.id` → `items` is an array of
 * `{ id }`). A key that also has children (an `array` rule alongside `items.*.id`) keeps its
 * modifiers on the node but renders from the children.
 */
function buildTree(fields: ResolvedField[]): TreeNode {
  const root = newNode();

  for (const field of fields) {
    const segments = field.key.split('.');
    let node = root;
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (!child) {
        child = newNode();
        node.children.set(segment, child);
      }
      node = child;
    }
    node.leaf = { type: field.type, optional: field.optional, nullable: field.nullable };
  }

  return root;
}

/** Whether a node's key is optional in its parent object (its own `sometimes` rule). */
function nodeOptional(node: TreeNode): boolean {
  return node.leaf?.optional ?? false;
}

/**
 * Render a tree node to a TypeScript type. A node with children renders as an array (when a
 * `*` child is present) or an object literal; a leaf renders its resolved type. A node's own
 * `nullable` modifier unions `| null` onto whichever shape it produces.
 */
function renderNode(node: TreeNode): string {
  let base: string;

  if (node.children.size > 0) {
    const star = node.children.get('*');
    if (star) {
      base = `${renderNode(star)}[]`;
    } else {
      const props = [...node.children.entries()].map(
        ([segment, child]) => `${renderKey(segment)}${nodeOptional(child) ? '?' : ''}: ${renderNode(child)}`
      );
      base = `{ ${props.join('; ')} }`;
    }
  } else {
    base = node.leaf?.type ?? 'any';
  }

  return node.leaf?.nullable ? `${base} | null` : base;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Build the final form entries from the collected inputs. Each form's `rules()` becomes a
 * field set: rule keys drive the shape (nesting and wildcards expand to nested objects and
 * arrays), tokens drive each leaf type, and a field with no static type signal degrades to the
 * strict-mode fallback (`unknown`) or `any` with a warning. A form whose `rules()` couldn't be
 * analyzed at all falls back to `Record<string, any|unknown>`. Never throws.
 */
export function buildForms(
  inputs: FormInput[],
  strict: boolean,
  enums: Record<string, EnumDefinition> = {},
  knownEnums: Set<string> = new Set()
): { forms: Record<string, FormEntry>; warnings: string[]; enumNames: Set<string> } {
  const forms: Record<string, FormEntry> = {};
  const warnings: string[] = [];
  const enumNames = new Set<string>();
  const fallback = strict ? 'unknown' : 'any';

  for (const input of inputs) {
    if (!input.rules) {
      forms[input.className] = { kind: 'fallback', record: fallback };
      warnings.push(
        `${input.className}: could not statically analyze rules(); typed as \`Record<string, ${fallback}>\`.`
      );
      continue;
    }

    const resolved: ResolvedField[] = [];
    for (const [key, tokens] of Object.entries(input.rules)) {
      // Annotation pin wins verbatim over rule-derived types and clears the degrade warning.
      if (input.annotations[key] !== undefined) {
        resolved.push({ key, type: input.annotations[key], optional: tokens.includes('sometimes'), nullable: false });
        continue;
      }

      const { type, optional, nullable, enum: enumUsed } = resolveTokens(tokens, enums, knownEnums);
      if (enumUsed) enumNames.add(enumUsed);
      if (type === null) {
        warnings.push(`${input.className}.${key} has no rule ferry can map to a type; typed as \`${fallback}\`.`);
        resolved.push({ key, type: fallback, optional, nullable: false });
        continue;
      }
      resolved.push({ key, type, optional, nullable });
    }

    const root = buildTree(resolved);
    const fields: Record<string, FormField> = {};
    for (const [segment, child] of root.children) {
      fields[segment] = { type: renderNode(child), optional: nodeOptional(child) };
    }

    forms[input.className] = { kind: 'shape', fields };
  }

  return { forms, warnings, enumNames };
}

// ---------------------------------------------------------------------------
// d.ts block rendering
// ---------------------------------------------------------------------------

/** Indent every non-empty line of a block by two spaces. */
function indentBlock(block: string): string {
  return block
    .split('\n')
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join('\n');
}

/** Render one form as an `export type` declaration. */
function renderFormType(name: string, entry: FormEntry): string {
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
 * The `declare module '@ferry/forms'` block for the ambient `index.d.ts`: one `export type`
 * per FormRequest, named by the class's verbatim short name. The data shape alone is emitted —
 * consumers derive typed `form.errors` keys from it via Inertia's `FormDataKeys<TForm>`.
 */
export function generateFormsDtsBlock(
  forms: Record<string, FormEntry>,
  enumNames: Set<string> = new Set()
): string {
  const names = Object.keys(forms).sort();
  if (names.length === 0) {
    return `declare module '${FORMS_MODULE_ID}' {}`;
  }

  // Only import the `<Enum>Value` types actually referenced by a rendered field type. The
  // import is block-scoped, so it does NOT flip the ambient file to module mode.
  const used = new Set<string>();
  for (const name of names) {
    const entry = forms[name];
    if (entry.kind !== 'shape') continue;
    for (const field of Object.values(entry.fields)) {
      for (const enumName of enumNames) {
        if (typeContainsName(field.type, `${enumName}Value`)) used.add(`${enumName}Value`);
      }
    }
  }

  const parts: string[] = [];
  if (used.size > 0) {
    parts.push(`import { ${[...used].sort().join(', ')} } from '${ENUMS_MODULE_ID}';`);
    parts.push('');
  }
  parts.push(names.map((name) => renderFormType(name, forms[name])).join('\n\n'));

  const inner = parts.join('\n');
  return `declare module '${FORMS_MODULE_ID}' {\n${indentBlock(inner)}\n}`;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Read every form-request file and statically analyze its `rules()`. Pure file I/O plus the
 * `php-parser` static pass — no PHP process. Recurses into subdirectories. Forms are keyed by
 * their short class name; a duplicate short name warns (first wins) or, under `strict`,
 * hard-fails. A missing requests directory yields no forms.
 */
export function collectFormInputs(options: { requestsDir: string; cwd: string; strict?: boolean }): FormInput[] {
  const { requestsDir, cwd, strict = false } = options;

  if (!existsSync(requestsDir)) {
    return [];
  }

  const inputs: FormInput[] = [];
  const seen = new Map<string, string>();

  for (const filePath of getPhpFilesRecursive(requestsDir)) {
    const className = parse(filePath).name;
    const relativePhpPath = relative(cwd, filePath);

    const firstPath = seen.get(className);
    if (firstPath !== undefined) {
      const message = `Duplicate form request class name '${className}': ${relative(cwd, firstPath)} and ${relativePhpPath}`;
      if (strict) {
        throw new Error(`${message}. Rename one, or disable strict mode to keep the first.`);
      }
      logWarn('forms', `${message}. Keeping the first; ignoring ${relativePhpPath}.`);
      continue;
    }
    seen.set(className, filePath);

    try {
      const content = readFileSafe(filePath) || '';
      inputs.push({
        className,
        rules: parseFormRequestRules(content),
        annotations: extractFerryAnnotations(content),
      });
    } catch (e) {
      logWarn('forms', `Failed to parse form request file: ${relativePhpPath} (${e})`);
    }
  }

  return inputs;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Collect form requests, build their data-shape types, and register the `@ferry/forms` runtime
 * (an empty type-only virtual module) plus the `declare module '@ferry/forms'` d.ts block with
 * the delivery layer. Degradation warnings are logged. Called on every generation pass and on
 * request-file changes in dev. Does not write the ambient file; the caller runs `writeTypes()`.
 */
export function registerForms({ requestsDir, cwd, delivery, strict = false }: FormRegisterOptions): void {
  // The enums ferry actually generates into `@ferry/enums`. A `Rule::enum(...)` reference is
  // resolved to `<Enum>Value` only when its short name is in this set.
  const enums = collectEnums(join(cwd, 'app/Enums'), cwd);
  const knownEnums = new Set(Object.keys(enums));

  const inputs = collectFormInputs({ requestsDir, cwd, strict });
  const { forms, warnings, enumNames } = buildForms(inputs, strict, enums, knownEnums);
  for (const warning of warnings) logWarn('forms', warning);

  delivery.virtual.register(FORMS_MODULE_ID, FORM_RUNTIME);
  delivery.dts.register(FORMS_MODULE_ID, generateFormsDtsBlock(forms, enumNames));
}
