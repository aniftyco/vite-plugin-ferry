import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as PhpParserTypes from 'php-parser';
import { readFileSafe } from './file.js';
import { mapPhpTypeToTs } from './type-mapper.js';

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
    withPositions: false,
  },
});

export type EnumCase = {
  key: string;
  value: string | number;
  label?: string;
};

export type EnumDefinition = {
  name: string;
  backing: string | null;
  cases: EnumCase[];
};

/**
 * Parse PHP content and return the AST.
 * Uses parseEval which doesn't require <?php tags or filenames.
 */
function parsePhp(content: string): PhpParserTypes.Program | null {
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
function findNodeByKind(ast: PhpParserTypes.Node, kind: string): PhpParserTypes.Node | null {
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
function findAllNodesByKind(ast: PhpParserTypes.Node, kind: string): PhpParserTypes.Node[] {
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
export function parseEnumContent(phpContent: string): EnumDefinition | null {
  const ast = parsePhp(phpContent);
  if (!ast) return null;

  // Find the enum declaration
  const enumNode = findNodeByKind(ast, 'enum') as PhpParserTypes.Enum | null;
  if (!enumNode) return null;

  const name = typeof enumNode.name === 'string' ? enumNode.name : (enumNode.name as PhpParserTypes.Identifier).name;
  const backing = enumNode.valueType ? (enumNode.valueType as PhpParserTypes.Identifier).name.toLowerCase() : null;

  // Extract enum cases
  const cases: EnumCase[] = [];
  const enumCases = findAllNodesByKind(enumNode, 'enumcase') as PhpParserTypes.EnumCase[];

  for (const enumCase of enumCases) {
    // Name can be an Identifier or string
    const key =
      typeof enumCase.name === 'string'
        ? enumCase.name
        : (enumCase.name as PhpParserTypes.Identifier).name;

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

    cases.push({ key, value });
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

  return { name, backing, cases };
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
        if (
          offset &&
          offset.kind === 'identifier' &&
          (offset as PhpParserTypes.Identifier).name === 'class'
        ) {
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
        typeof prop.name === 'string'
          ? prop.name
          : (prop.name as unknown as PhpParserTypes.Identifier).name;
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
 * Extract property name from $this->resource->property.
 */
function extractResourceProperty(node: PhpParserTypes.Node): string | null {
  if (node.kind !== 'propertylookup') return null;

  const lookup = node as PhpParserTypes.PropertyLookup;
  const what = lookup.what;

  // Check for $this->resource
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

  return null;
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
function inferTypeFromAstNode(
  node: PhpParserTypes.Node,
  key: string,
  options: ParseResourceOptions = {}
): ResourceFieldInfo {
  const { resourcesDir, modelsDir, enumsDir, docShape, collectedEnums = {}, resourceClass = '' } = options;
  const optional = containsWhenLoaded(node);

  // Use docblock type if available
  if (docShape && docShape[key]) {
    return { type: docShape[key], optional };
  }

  // Boolean heuristics from key name
  const lowerKey = key.toLowerCase();
  if (lowerKey.startsWith('is_') || lowerKey.startsWith('has_') || /^(is|has)[A-Z]/.test(key)) {
    return { type: 'boolean', optional };
  }

  // Handle static calls: Resource::collection() or Resource::make()
  if (node.kind === 'call') {
    const call = node as PhpParserTypes.Call;
    const staticInfo = extractStaticCallResource(call);
    if (staticInfo) {
      const { resource, method } = staticInfo;
      // Collection or Collection::make returns any[]
      if (resource === 'Collection') {
        return { type: 'any[]', optional };
      }
      // Resource::collection or Resource::make returns Resource[]
      if (method === 'collection' || method === 'make') {
        if (resourceExists(resource, resourcesDir)) {
          return { type: `${resource}[]`, optional };
        }
        return { type: 'any[]', optional };
      }
    }

    // Check if it's a whenLoaded call without a wrapper resource
    if (call.what.kind === 'propertylookup') {
      const lookup = call.what as unknown as PhpParserTypes.PropertyLookup;
      const offset = lookup.offset;
      const name = offset.kind === 'identifier' ? (offset as PhpParserTypes.Identifier).name : null;
      if (name === 'whenLoaded') {
        // Try to find matching resource (only if resourcesDir is provided)
        if (resourcesDir) {
          const args = call.arguments;
          if (args.length > 0 && args[0].kind === 'string') {
            const relationName = (args[0] as PhpParserTypes.String).value;
            const candidate = `${relationName[0].toUpperCase()}${relationName.slice(1)}Resource`;
            if (existsSync(join(resourcesDir, `${candidate}.php`))) {
              return { type: candidate, optional: true };
            }
          }
        }
        return { type: 'Record<string, any>', optional: true };
      }
    }
  }

  // Handle new Resource()
  if (node.kind === 'new') {
    const newExpr = node as PhpParserTypes.New;
    const resource = extractNewResource(newExpr);
    if (resource) {
      if (resourceExists(resource, resourcesDir)) {
        return { type: resource, optional };
      }
      return { type: 'any', optional };
    }
    return { type: 'any', optional };
  }

  // Handle $this->resource->property
  const prop = extractResourceProperty(node);
  if (prop) {
    const lower = prop.toLowerCase();

    // Boolean checks
    if (lower.startsWith('is_') || lower.startsWith('has_') || /^(is|has)[A-Z]/.test(prop)) {
      return { type: 'boolean', optional: false };
    }

    // IDs and UUIDs
    if (prop === 'id' || prop.endsWith('_id') || lower === 'uuid' || prop.endsWith('Id')) {
      return { type: 'string', optional: false };
    }

    // Check model casts
    if (modelsDir && resourceClass) {
      const modelCandidate = resourceClass.replace(/Resource$/, '');
      const modelPath = join(modelsDir, `${modelCandidate}.php`);

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
            return { type: tsType, optional: false };
          }
        }
      }
    }

    // Timestamps
    if (prop.endsWith('_at') || prop.endsWith('At')) {
      return { type: 'string', optional: false };
    }

    return { type: 'string', optional: false };
  }

  // Handle nested arrays
  if (node.kind === 'array') {
    const arrayNode = node as PhpParserTypes.Array;
    const nestedFields = parseArrayEntries(arrayNode.items, options);
    if (Object.keys(nestedFields).length > 0) {
      const props = Object.entries(nestedFields).map(([k, v]) => {
        const opt = v.fieldInfo.optional ? '?' : '';
        return `${k}${opt}: ${v.fieldInfo.type}`;
      });
      return { type: `{ ${props.join('; ')} }`, optional };
    }
    return { type: 'any[]', optional };
  }

  return { type: 'any', optional };
}

/**
 * Parse array entries from AST array items.
 */
function parseArrayEntries(
  items: (PhpParserTypes.Entry | PhpParserTypes.Expression | PhpParserTypes.Variable)[],
  options: ParseResourceOptions = {}
): Record<string, ResourceArrayEntry> {
  const result: Record<string, ResourceArrayEntry> = {};

  for (const item of items) {
    if (item.kind !== 'entry') continue;

    const entry = item as PhpParserTypes.Entry;
    if (!entry.key) continue;

    const key = getStringValue(entry.key);
    if (!key) continue;

    const fieldInfo = inferTypeFromAstNode(entry.value, key, options);
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
    typeof classNode.name === 'string'
      ? classNode.name
      : (classNode.name as PhpParserTypes.Identifier).name;

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
  const entries = parseArrayEntries(arrayNode.items, { ...options, resourceClass: className });

  // Convert to flat field info
  const result: Record<string, ResourceFieldInfo> = {};
  for (const [key, entry] of Object.entries(entries)) {
    result[key] = entry.fieldInfo;
  }

  return result;
}
