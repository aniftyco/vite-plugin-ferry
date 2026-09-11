import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as PhpParserTypes from 'php-parser';
import { readFileSafe } from './file.js';
import { mapPhpTypeToTs } from './type-mapper.js';
import { renderKey } from './ts-keys.js';

// Import php-parser (CommonJS module with constructor)
const require = createRequire(import.meta.url);
const PhpParser = require('php-parser') as new (options?: object) => PhpParserTypes.Engine;

// Initialize the PHP parser (PHP 8+ only)
const parser = new PhpParser({
  parser: {
    extractDoc: true,
    php8: true,
  },
  ast: {
    withPositions: true,
  },
});

export type SourceLocation = {
  file: string;
  line: number;
  column?: number;
};

export type EnumCase = {
  key: string;
  value: string | number;
  label?: string;
  loc?: SourceLocation;
};

export type EnumDefinition = {
  name: string;
  backing: string | null;
  cases: EnumCase[];
  loc?: SourceLocation;
};

/**
 * Parse PHP content and return the AST.
 * Uses parseEval which doesn't require <?php tags or filenames.
 */
export function parsePhp(content: string): PhpParserTypes.Program | null {
  try {
    // Strip <?php tag if present (parseEval expects raw PHP code)
    let code = content.trimStart();
    if (code.startsWith('<?php')) {
      code = code.slice(5);
    } else if (code.startsWith('<?')) {
      code = code.slice(2);
    }
    return parser.parseEval(code);
  } catch {
    return null;
  }
}

/**
 * Walk all child nodes in an AST node.
 */
function walkChildren(node: PhpParserTypes.Node, callback: (child: PhpParserTypes.Node) => boolean): boolean {
  const obj = node as any;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object' && val.kind) {
      if (callback(val)) return true;
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object' && item.kind) {
          if (callback(item)) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Find a node by kind in the AST.
 */
export function findNodeByKind(ast: PhpParserTypes.Node, kind: string): PhpParserTypes.Node | null {
  if (ast.kind === kind) return ast;

  let result: PhpParserTypes.Node | null = null;
  walkChildren(ast, (child) => {
    const found = findNodeByKind(child, kind);
    if (found) {
      result = found;
      return true;
    }
    return false;
  });

  return result;
}

/**
 * Find all nodes of a specific kind in the AST.
 */
export function findAllNodesByKind(ast: PhpParserTypes.Node, kind: string): PhpParserTypes.Node[] {
  const results: PhpParserTypes.Node[] = [];

  function walk(node: PhpParserTypes.Node) {
    if (node.kind === kind) {
      results.push(node);
    }
    walkChildren(node, (child) => {
      walk(child);
      return false;
    });
  }

  walk(ast);
  return results;
}

/**
 * Extract string value from a PHP literal node.
 */
function getStringValue(node: PhpParserTypes.Node): string | null {
  if (node.kind === 'string') {
    return (node as PhpParserTypes.String).value;
  }
  if (node.kind === 'number') {
    return String((node as PhpParserTypes.Number).value);
  }
  return null;
}

/**
 * Parse PHP enum content and extract its definition.
 * This is a pure function that takes PHP source code as input.
 */
export function parseEnumContent(phpContent: string, filePath?: string): EnumDefinition | null {
  const ast = parsePhp(phpContent);
  if (!ast) return null;

  // Find the enum declaration
  const enumNode = findNodeByKind(ast, 'enum') as PhpParserTypes.Enum | null;
  if (!enumNode) return null;

  const name = typeof enumNode.name === 'string' ? enumNode.name : (enumNode.name as PhpParserTypes.Identifier).name;
  const backing = enumNode.valueType ? (enumNode.valueType as PhpParserTypes.Identifier).name.toLowerCase() : null;

  // Capture enum location
  const enumLoc: SourceLocation | undefined =
    filePath && (enumNode as any).loc?.start
      ? { file: filePath, line: (enumNode as any).loc.start.line, column: (enumNode as any).loc.start.column }
      : undefined;

  // Extract enum cases
  const cases: EnumCase[] = [];
  const enumCases = findAllNodesByKind(enumNode, 'enumcase') as PhpParserTypes.EnumCase[];

  for (const enumCase of enumCases) {
    // Name can be an Identifier or string
    const key = typeof enumCase.name === 'string' ? enumCase.name : (enumCase.name as PhpParserTypes.Identifier).name;

    let value: string | number;
    if (enumCase.value !== null && enumCase.value !== undefined) {
      // Value is a String or Number node (types say string|number but runtime is Node)
      const valueNode = enumCase.value as unknown as PhpParserTypes.Node;
      if (typeof valueNode === 'object' && valueNode.kind) {
        if (valueNode.kind === 'number') {
          // php-parser returns number values as strings, convert to actual number
          value = Number((valueNode as PhpParserTypes.Number).value);
        } else {
          const extracted = getStringValue(valueNode);
          value = extracted !== null ? extracted : key;
        }
      } else {
        value = String(enumCase.value);
      }
    } else {
      value = key;
    }

    // Capture case location
    const caseLoc: SourceLocation | undefined =
      filePath && (enumCase as any).loc?.start
        ? { file: filePath, line: (enumCase as any).loc.start.line, column: (enumCase as any).loc.start.column }
        : undefined;

    cases.push({ key, value, loc: caseLoc });
  }

  // Parse label() method if it exists
  const methods = findAllNodesByKind(enumNode, 'method') as PhpParserTypes.Method[];
  const labelMethod = methods.find((m) => {
    const methodName = typeof m.name === 'string' ? m.name : (m.name as PhpParserTypes.Identifier).name;
    return methodName === 'label';
  });

  if (labelMethod && labelMethod.body) {
    // Find match expression in the method
    const matchNode = findNodeByKind(labelMethod.body, 'match') as PhpParserTypes.Match | null;
    if (matchNode && matchNode.arms) {
      for (const arm of matchNode.arms) {
        if (arm.conds) {
          for (const cond of arm.conds) {
            // Handle self::CASE_NAME
            if (cond.kind === 'staticlookup') {
              const lookup = cond as PhpParserTypes.StaticLookup;
              const offset = lookup.offset;
              const caseName =
                typeof offset === 'string'
                  ? offset
                  : offset.kind === 'identifier'
                    ? (offset as PhpParserTypes.Identifier).name
                    : null;

              if (caseName) {
                const labelValue = getStringValue(arm.body);
                if (labelValue !== null) {
                  const enumCase = cases.find((c) => c.key === caseName);
                  if (enumCase) {
                    enumCase.label = labelValue;
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return { name, backing, cases, loc: enumLoc };
}

/**
 * Extract key-value pairs from a PHP array node.
 */
function extractArrayPairs(arrayNode: PhpParserTypes.Array): Record<string, string> {
  const pairs: Record<string, string> = {};

  for (const item of arrayNode.items) {
    if (item.kind === 'entry') {
      const entry = item as PhpParserTypes.Entry;
      const key = entry.key ? getStringValue(entry.key) : null;
      if (!key) continue;

      const value = entry.value;
      let strValue: string | null = null;

      if (value.kind === 'string' || value.kind === 'number') {
        strValue = getStringValue(value);
      } else if (value.kind === 'staticlookup') {
        // Handle Foo::class
        const lookup = value as PhpParserTypes.StaticLookup;
        const offset = lookup.offset;
        if (offset && offset.kind === 'identifier' && (offset as PhpParserTypes.Identifier).name === 'class') {
          const what = lookup.what;
          if (what.kind === 'name') {
            strValue = (what as PhpParserTypes.Name).name.replace(/^\\+/, '');
          }
        }
      }

      if (strValue !== null) {
        pairs[key] = strValue;
      }
    }
  }

  return pairs;
}

/**
 * Parse model casts from PHP model content.
 * This is a pure function that takes PHP source code as input.
 */
export function parseModelCasts(phpContent: string): Record<string, string> {
  const ast = parsePhp(phpContent);
  if (!ast) return {};

  // Find the class
  const classNode = findNodeByKind(ast, 'class') as PhpParserTypes.Class | null;
  if (!classNode) return {};

  // Look for protected $casts property
  const propertyStatements = findAllNodesByKind(classNode, 'propertystatement') as PhpParserTypes.PropertyStatement[];

  for (const propStmt of propertyStatements) {
    for (const prop of propStmt.properties) {
      // prop.name can be a string or Identifier
      const propName =
        typeof prop.name === 'string' ? prop.name : (prop.name as unknown as PhpParserTypes.Identifier).name;
      if (propName === 'casts' && prop.value && prop.value.kind === 'array') {
        return extractArrayPairs(prop.value as PhpParserTypes.Array);
      }
    }
  }

  // Look for casts() method
  const methods = findAllNodesByKind(classNode, 'method') as PhpParserTypes.Method[];
  const castsMethod = methods.find((m) => {
    const methodName = typeof m.name === 'string' ? m.name : (m.name as PhpParserTypes.Identifier).name;
    return methodName === 'casts';
  });

  if (castsMethod && castsMethod.body) {
    // Find return statement with array
    const returnNode = findNodeByKind(castsMethod.body, 'return') as PhpParserTypes.Return | null;
    if (returnNode && returnNode.expr && returnNode.expr.kind === 'array') {
      return extractArrayPairs(returnNode.expr as PhpParserTypes.Array);
    }
  }

  return {};
}

/**
 * Extract docblock array shape from PHP content.
 * This is a pure function that takes PHP source code as input.
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

  // Extract content and strip docblock asterisks from multiline format
  let inside = phpContent.slice(openBracePos + 1, endPos);
  inside = inside.replace(/^\s*\*\s?/gm, '');

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

export type ResourceFieldInfo = {
  type: string;
  optional: boolean;
  loc?: SourceLocation;
  /** The model property this field reads (`$this->resource->prop`, bare `$this->prop`, or a
   * `whenHas('prop')` key), when known. Lets the metadata dump override the static leaf type
   * with the real column/cast type. */
  column?: string;
  /** True when the value is an arbitrary expression ferry can't resolve statically (a
   * method call, a loop-built array, etc.). Signals the caller to degrade the type. */
  undecidable?: boolean;
  /** Strip a `| null` from the resolved leaf type — a `whenNotNull()` value can't be null. */
  stripNull?: boolean;
  /** Append `| <type>` to the resolved leaf type — a `when($cond, value, default)` default.
   * Carries the default's static fallback type; used when `unionWithColumn` has no metadata. */
  unionWith?: string;
  /** A column-valued `when()` default: the merge resolves it through the metadata dump the
   * same way the value column does, so the field becomes `value | default`. */
  unionWithColumn?: string;
  /** Append `| null` to the (kept) static type when this source column is nullable — a
   * `new XResource($this->col)` / `XResource::make($this->col)` over a nullable attribute. */
  nullFromColumn?: string;
};

export type ResourceArrayEntry = {
  key: string;
  fieldInfo: ResourceFieldInfo;
  nested?: Record<string, ResourceArrayEntry>;
};

export type ParseResourceOptions = {
  resourcesDir?: string;
  modelsDir?: string;
  enumsDir?: string;
  docShape?: Record<string, string> | null;
  collectedEnums?: Record<string, EnumDefinition>;
  resourceClass?: string;
  /** The backing model's short name (from `@mixin`), overriding the `Resource`-suffix
   * naming convention for the static model-cast lookup. */
  modelName?: string;
  filePath?: string;
};

/**
 * Check if an AST node contains a whenLoaded call.
 */
function containsWhenLoaded(node: PhpParserTypes.Node): boolean {
  if (node.kind === 'call') {
    const call = node as PhpParserTypes.Call;
    if (call.what.kind === 'propertylookup') {
      const lookup = call.what as unknown as PhpParserTypes.PropertyLookup;
      const offset = lookup.offset;
      const name = offset.kind === 'identifier' ? (offset as PhpParserTypes.Identifier).name : null;
      if (name === 'whenLoaded') return true;
    }
  }

  // Check arguments recursively
  const obj = node as any;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object') {
      if (val.kind && containsWhenLoaded(val)) return true;
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item && item.kind && containsWhenLoaded(item)) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Extract resource name from a static call like Resource::make() or Resource::collection().
 */
function extractStaticCallResource(call: PhpParserTypes.Call): { resource: string; method: string } | null {
  if (call.what.kind !== 'staticlookup') return null;

  const lookup = call.what as unknown as PhpParserTypes.StaticLookup;
  if (lookup.what.kind !== 'name') return null;

  const resource = (lookup.what as PhpParserTypes.Name).name;
  const offset = lookup.offset;
  const method = offset.kind === 'identifier' ? (offset as PhpParserTypes.Identifier).name : null;

  if (!method) return null;
  return { resource, method };
}

/**
 * Extract resource name from a new expression like new Resource().
 */
function extractNewResource(newExpr: PhpParserTypes.New): string | null {
  if (newExpr.what.kind !== 'name') return null;
  return (newExpr.what as PhpParserTypes.Name).name;
}

/**
 * Extract the model attribute name a node reads. Two equivalent forms resolve the same way,
 * since a resource proxies `$this->prop` to `$this->resource->prop` through `__get`:
 *
 * - `$this->resource->prop` — the explicit form.
 * - `$this->prop` — the bare form (excluding `$this->resource` itself, which is the model).
 */
function extractResourceProperty(node: PhpParserTypes.Node): string | null {
  if (node.kind !== 'propertylookup') return null;

  const lookup = node as PhpParserTypes.PropertyLookup;
  const what = lookup.what;

  // $this->resource->prop
  if (what.kind === 'propertylookup') {
    const inner = what as PhpParserTypes.PropertyLookup;
    if (inner.what.kind === 'variable' && (inner.what as PhpParserTypes.Variable).name === 'this') {
      const innerOffset = inner.offset;
      const innerName = innerOffset.kind === 'identifier' ? (innerOffset as PhpParserTypes.Identifier).name : null;
      if (innerName === 'resource') {
        const offset = lookup.offset;
        return offset.kind === 'identifier' ? (offset as PhpParserTypes.Identifier).name : null;
      }
    }
  }

  // Bare $this->prop (not $this->resource, which is the model itself).
  if (what.kind === 'variable' && (what as PhpParserTypes.Variable).name === 'this') {
    const offset = lookup.offset;
    const name = offset.kind === 'identifier' ? (offset as PhpParserTypes.Identifier).name : null;
    if (name && name !== 'resource') return name;
  }

  return null;
}

/**
 * Read the backing model's short name from a `@mixin` docblock tag, e.g.
 * `@mixin \App\Models\Order` → `Order`. Returns null when no `@mixin` is present, so the
 * caller falls back to the `Resource`-suffix naming convention.
 */
export function extractMixinModel(phpContent: string): string | null {
  const match = phpContent.match(/@mixin\s+([\\A-Za-z0-9_]+)/);
  if (!match) return null;
  const short = match[1].replace(/^\\+/, '').split('\\').pop();
  return short || null;
}

/**
 * Map a PHP cast to a TypeScript type, potentially collecting enum references.
 */
function mapCastToType(cast: string, enumsDir: string, collectedEnums: Record<string, EnumDefinition>): string {
  const original = cast;

  // Try to find enum in app/Enums
  const match = original.match(/([A-Za-z0-9_\\]+)$/);
  const short = match ? match[1].replace(/^\\+/, '') : original;
  const enumPath = join(enumsDir, `${short}.php`);

  if (existsSync(enumPath)) {
    const content = readFileSafe(enumPath);
    if (content) {
      const def = parseEnumContent(content);
      if (def) {
        collectedEnums[def.name] = def;
        return def.name;
      }
    }
  }

  return mapPhpTypeToTs(cast);
}

/**
 * Check if a resource file exists.
 */
function resourceExists(resourceName: string, resourcesDir: string | undefined): boolean {
  if (!resourcesDir) return true; // Trust the name if no dir provided
  return existsSync(join(resourcesDir, `${resourceName}.php`));
}

/**
 * Infer TypeScript type from an AST value node.
 */
export function getNodeStringValue(node: PhpParserTypes.Node): string | null {
  return getStringValue(node);
}

/**
 * Resolve a model attribute reference to its field info. The `column` is always recorded so
 * the metadata dump can override the static leaf type with the real column/cast type; the
 * static type here is the offline fallback (model-cast file, then name heuristics).
 */
function resolveColumnField(prop: string, optional: boolean, options: ParseResourceOptions): ResourceFieldInfo {
  const { modelsDir, enumsDir, collectedEnums = {}, resourceClass = '', modelName } = options;
  const lower = prop.toLowerCase();

  // Booleans by name.
  if (lower.startsWith('is_') || lower.startsWith('has_') || /^(is|has)[A-Z]/.test(prop)) {
    return { type: 'boolean', optional, column: prop };
  }

  // IDs and UUIDs.
  if (prop === 'id' || prop.endsWith('_id') || lower === 'uuid' || prop.endsWith('Id')) {
    return { type: 'string', optional, column: prop };
  }

  // Offline model casts, keyed by the `@mixin` model (or the Resource-suffix convention).
  const model = modelName || (resourceClass ? resourceClass.replace(/Resource$/, '') : '');
  if (modelsDir && model) {
    const modelPath = join(modelsDir, `${model}.php`);
    if (existsSync(modelPath)) {
      const modelContent = readFileSafe(modelPath);
      if (modelContent) {
        const casts = parseModelCasts(modelContent);
        if (casts[prop]) {
          const cast = casts[prop];
          const trim = cast.trim();
          const tsType =
            trim.startsWith('{') || trim.includes(':') || /array\s*\{/.test(trim)
              ? trim
              : mapCastToType(cast, enumsDir || '', collectedEnums);
          return { type: tsType, optional, column: prop };
        }
      }
    }
  }

  // Date attributes serialize to strings.
  if (prop.endsWith('_at') || prop.endsWith('At')) {
    return { type: 'string', optional, column: prop };
  }

  return { type: 'string', optional, column: prop };
}

/** Name of an instance method call `$this->method(...)`, or null. */
function instanceMethodName(call: PhpParserTypes.Call): string | null {
  if (call.what.kind !== 'propertylookup') return null;
  const lookup = call.what as unknown as PhpParserTypes.PropertyLookup;
  const offset = lookup.offset;
  return offset.kind === 'identifier' ? (offset as PhpParserTypes.Identifier).name : null;
}

/** The source column of a resource-wrapping argument (`new X($this->col)`), or null. */
function resourceSourceColumn(args: readonly PhpParserTypes.Node[]): string | null {
  if (!args || args.length === 0) return null;
  return extractResourceProperty(args[0]);
}

/**
 * Resolve a Laravel conditional-attribute helper call (`when`, `whenHas`, `whenNotNull`, …).
 * Returns null when the method isn't one ferry types, so the caller falls through to the
 * generic handling (ultimately the `@ferry` docblock or a clean degrade).
 */
function handleInstanceMethod(
  name: string,
  call: PhpParserTypes.Call,
  key: string,
  options: ParseResourceOptions
): ResourceFieldInfo | null {
  const { resourcesDir } = options;
  const args = (call.arguments ?? []) as PhpParserTypes.Node[];

  switch (name) {
    // whenLoaded('rel') — resolve the relation's resource when it exists, else a loose record.
    case 'whenLoaded': {
      if (resourcesDir && args.length > 0 && args[0].kind === 'string') {
        const relationName = (args[0] as PhpParserTypes.String).value;
        if (relationName.length > 0) {
          const candidate = `${relationName[0].toUpperCase()}${relationName.slice(1)}Resource`;
          if (existsSync(join(resourcesDir, `${candidate}.php`))) {
            return { type: candidate, optional: true };
          }
        }
      }
      return { type: 'Record<string, any>', optional: true };
    }

    // Aggregates load conditionally and serialize to numbers.
    case 'whenCounted':
    case 'whenAggregated':
      return { type: 'number', optional: true };

    // A conditional existence check serializes to a boolean.
    case 'whenExistsLoaded':
      return { type: 'boolean', optional: true };

    // whenHas('attr') — the attribute's type, key optional.
    case 'whenHas': {
      if (args.length > 0 && args[0].kind === 'string') {
        return resolveColumnField((args[0] as PhpParserTypes.String).value, true, options);
      }
      return { type: 'any', optional: true, undecidable: true };
    }

    // whenNotNull(value) — the value's type with `| null` stripped, key optional.
    case 'whenNotNull': {
      if (args.length === 0) return { type: 'any', optional: true, undecidable: true };
      const info = inferTypeFromAstNode(args[0], key, options);
      info.optional = true;
      info.stripNull = true;
      return info;
    }

    // whenNull(value) — the value's (nullable) type, key optional.
    case 'whenNull': {
      if (args.length === 0) return { type: 'any', optional: true, undecidable: true };
      const info = inferTypeFromAstNode(args[0], key, options);
      info.optional = true;
      return info;
    }

    // when($cond, value[, default]) / unless(...) — no default marks the key optional; an
    // explicit default keeps the key present and unions the value with the default's type.
    case 'when':
    case 'unless': {
      if (args.length < 2) return { type: 'any', optional: true, undecidable: true };
      const valueInfo = inferTypeFromAstNode(args[1], key, options);
      if (args.length >= 3) {
        const defaultInfo = inferTypeFromAstNode(args[2], key, options);
        valueInfo.optional = false;
        // An explicit default makes the field `value | default`. A default that can't be
        // resolved at all degrades the whole field rather than silently narrowing it; a
        // column-valued default resolves through the metadata dump at merge time.
        if (defaultInfo.undecidable) {
          return { type: 'any', optional: false, undecidable: true };
        }
        valueInfo.unionWith = defaultInfo.type;
        if (defaultInfo.column) valueInfo.unionWithColumn = defaultInfo.column;
        return valueInfo;
      }
      valueInfo.optional = true;
      return valueInfo;
    }

    default:
      return null;
  }
}

export function inferTypeFromAstNode(
  node: PhpParserTypes.Node,
  key: string,
  options: ParseResourceOptions = {}
): ResourceFieldInfo {
  const { resourcesDir, docShape } = options;
  const optional = containsWhenLoaded(node);

  // Use docblock type if available
  if (docShape && docShape[key]) {
    return { type: docShape[key], optional };
  }

  // Handle calls: Resource::make()/collection() and the conditional-attribute helpers.
  if (node.kind === 'call') {
    const call = node as PhpParserTypes.Call;
    const staticInfo = extractStaticCallResource(call);
    if (staticInfo) {
      const { resource, method } = staticInfo;
      // Collection or Collection::make returns any[]
      if (resource === 'Collection') {
        return { type: 'any[]', optional };
      }
      // Resource::collection returns Resource[] (array of resources)
      if (method === 'collection') {
        if (resourceExists(resource, resourcesDir)) {
          return { type: `${resource}[]`, optional };
        }
        return { type: 'any[]', optional };
      }
      // Resource::make returns a single Resource (| null when the source column is nullable).
      if (method === 'make') {
        if (resourceExists(resource, resourcesDir)) {
          const nullFromColumn = resourceSourceColumn(call.arguments as PhpParserTypes.Node[]);
          return { type: resource, optional, ...(nullFromColumn ? { nullFromColumn } : {}) };
        }
        return { type: 'any', optional };
      }
    }

    // Instance method: $this->whenLoaded(...), $this->when(...), etc.
    const method = instanceMethodName(call);
    if (method) {
      const handled = handleInstanceMethod(method, call, key, options);
      if (handled) return handled;
    }
  }

  // Handle new Resource() (| null when the source column is nullable).
  if (node.kind === 'new') {
    const newExpr = node as PhpParserTypes.New;
    const resource = extractNewResource(newExpr);
    if (resource) {
      if (resourceExists(resource, resourcesDir)) {
        const nullFromColumn = resourceSourceColumn((newExpr.arguments ?? []) as PhpParserTypes.Node[]);
        return { type: resource, optional, ...(nullFromColumn ? { nullFromColumn } : {}) };
      }
      return { type: 'any', optional };
    }
    return { type: 'any', optional };
  }

  // Boolean heuristics from key name (after calls, so a helper on an is_/has_ key still wins).
  const lowerKey = key.toLowerCase();
  if (lowerKey.startsWith('is_') || lowerKey.startsWith('has_') || /^(is|has)[A-Z]/.test(key)) {
    return { type: 'boolean', optional };
  }

  // Handle $this->resource->property and bare $this->property.
  const prop = extractResourceProperty(node);
  if (prop) {
    return resolveColumnField(prop, false, options);
  }

  // Literals and simple computed scalars.
  if (node.kind === 'string') return { type: 'string', optional };
  if (node.kind === 'number') return { type: 'number', optional };
  if (node.kind === 'boolean') return { type: 'boolean', optional };
  // String concatenation (`$a . $b`) is always a string.
  if (node.kind === 'bin' && (node as PhpParserTypes.Bin).type === '.') return { type: 'string', optional };

  // Handle nested arrays
  if (node.kind === 'array') {
    const arrayNode = node as PhpParserTypes.Array;
    const nestedFields = parseArrayEntries(arrayNode.items, options);
    if (Object.keys(nestedFields).length > 0) {
      const props = Object.entries(nestedFields).map(([k, v]) => {
        const opt = v.fieldInfo.optional ? '?' : '';
        return `${renderKey(k)}${opt}: ${v.fieldInfo.type}`;
      });
      return { type: `{ ${props.join('; ')} }`, optional };
    }
    return { type: 'any[]', optional };
  }

  // Arbitrary expression ferry can't resolve statically (method call, ternary of two
  // shapes, loop-built array, etc.): mark it so the caller degrades the type.
  return { type: 'any', optional, undecidable: true };
}

/**
 * Flatten a keyless array item into the fields it contributes. Two documented cases:
 *
 * - A spread of an inline array literal (`...['a' => 1]`) — its keys are present
 *   unconditionally, so they keep their inferred optionality.
 * - `mergeWhen($cond, [...])` — the merge is conditional, so every contributed key is
 *   marked optional, matching the `when()`/`whenLoaded()` convention.
 *
 * Anything else (a spread of a runtime expression whose keys ferry can't see statically)
 * contributes nothing.
 */
function flattenKeylessEntry(
  entry: PhpParserTypes.Entry,
  options: ParseResourceOptions
): Record<string, ResourceArrayEntry> {
  // Spread of an inline array literal: `...['a' => 1]`.
  if ((entry as any).unpack && entry.value.kind === 'array') {
    return parseArrayEntries((entry.value as PhpParserTypes.Array).items, options);
  }

  // `mergeWhen($cond, [...])` — conditional, so contributed keys become optional.
  if (entry.value.kind === 'call') {
    const call = entry.value as PhpParserTypes.Call;
    if (call.what.kind === 'propertylookup') {
      const lookup = call.what as unknown as PhpParserTypes.PropertyLookup;
      const offset = lookup.offset;
      const name = offset.kind === 'identifier' ? (offset as PhpParserTypes.Identifier).name : null;
      if (name === 'mergeWhen') {
        const arrayArg = call.arguments.find((a) => a.kind === 'array') as PhpParserTypes.Array | undefined;
        if (arrayArg) {
          const nested = parseArrayEntries(arrayArg.items, options);
          for (const v of Object.values(nested)) {
            v.fieldInfo.optional = true;
          }
          return nested;
        }
      }
    }
  }

  return {};
}

/**
 * Parse array entries from AST array items.
 */
function parseArrayEntries(
  items: (PhpParserTypes.Entry | PhpParserTypes.Expression | PhpParserTypes.Variable)[],
  options: ParseResourceOptions = {}
): Record<string, ResourceArrayEntry> {
  const result: Record<string, ResourceArrayEntry> = {};
  const { filePath } = options;

  for (const item of items) {
    if (item.kind !== 'entry') continue;

    const entry = item as PhpParserTypes.Entry;

    // A keyless item is a spread (`...['a' => 1]`) or a `mergeWhen($cond, [...])`: flatten
    // the keys it contributes into this shape rather than dropping it.
    if (!entry.key) {
      for (const [k, v] of Object.entries(flattenKeylessEntry(entry, options))) {
        result[k] = v;
      }
      continue;
    }

    const key = getStringValue(entry.key);
    if (!key) continue;

    const fieldInfo = inferTypeFromAstNode(entry.value, key, options);

    // Capture field location from the entry key
    if (filePath && (entry.key as any).loc?.start) {
      fieldInfo.loc = {
        file: filePath,
        line: (entry.key as any).loc.start.line,
        column: (entry.key as any).loc.start.column,
      };
    }

    result[key] = { key, fieldInfo };

    // Handle nested arrays
    if (entry.value.kind === 'array') {
      const nested = parseArrayEntries((entry.value as PhpParserTypes.Array).items, options);
      if (Object.keys(nested).length > 0) {
        result[key].nested = nested;
      }
    }
  }

  return result;
}

/**
 * Parse resource fields from PHP content using AST.
 * Returns null if parsing fails or no toArray method is found.
 */
export function parseResourceFieldsAst(
  phpContent: string,
  options: Omit<ParseResourceOptions, 'resourceClass'> = {}
): Record<string, ResourceFieldInfo> | null {
  const ast = parsePhp(phpContent);
  if (!ast) return null;

  // Find the class
  const classNode = findNodeByKind(ast, 'class') as PhpParserTypes.Class | null;
  if (!classNode) return null;

  // Extract class name for model cast lookups
  const className =
    typeof classNode.name === 'string' ? classNode.name : (classNode.name as PhpParserTypes.Identifier).name;

  // Find toArray method
  const methods = findAllNodesByKind(classNode, 'method') as PhpParserTypes.Method[];
  const toArrayMethod = methods.find((m) => {
    const methodName = typeof m.name === 'string' ? m.name : (m.name as PhpParserTypes.Identifier).name;
    return methodName === 'toArray';
  });

  if (!toArrayMethod || !toArrayMethod.body) return null;

  // Find return statement with array
  const returnNode = findNodeByKind(toArrayMethod.body, 'return') as PhpParserTypes.Return | null;
  if (!returnNode || !returnNode.expr || returnNode.expr.kind !== 'array') return null;

  const arrayNode = returnNode.expr as PhpParserTypes.Array;
  const modelName = options.modelName ?? extractMixinModel(phpContent) ?? undefined;
  const entries = parseArrayEntries(arrayNode.items, { ...options, resourceClass: className, modelName });

  // Convert to flat field info
  const result: Record<string, ResourceFieldInfo> = {};
  for (const [key, entry] of Object.entries(entries)) {
    result[key] = entry.fieldInfo;
  }

  return result;
}

/**
 * Read `@ferry <field> <TS type>` docblock tags — the annotation escape hatch. Each
 * line pins one field to a raw TypeScript type, emitted verbatim (no inference). The
 * type is the rest of the line, so it may contain spaces (`Record<string, string>`).
 * Returns a map of field name to its raw TS type.
 */
export function extractFerryAnnotations(phpContent: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of phpContent.split('\n')) {
    // Strip a leading docblock asterisk so ` * @ferry ...` matches too.
    const line = rawLine.replace(/^\s*\*\s?/, '').trim();
    const match = line.match(/^@ferry\s+([A-Za-z0-9_]+)\s+(.+)$/);
    if (!match) continue;

    const field = match[1];
    // Drop a trailing `*/` if the tag sits on the docblock's closing line.
    const type = match[2].replace(/\*\/\s*$/, '').trim();
    if (type) result[field] = type;
  }

  return result;
}
