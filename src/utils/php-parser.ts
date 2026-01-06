import type * as PhpParserTypes from 'php-parser';

// Import php-parser (CommonJS module with constructor)
// eslint-disable-next-line @typescript-eslint/no-require-imports
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

  // Parse getLabel() method if it exists
  const methods = findAllNodesByKind(enumNode, 'method') as PhpParserTypes.Method[];
  const getLabelMethod = methods.find((m) => {
    const methodName = typeof m.name === 'string' ? m.name : (m.name as PhpParserTypes.Identifier).name;
    return methodName === 'getLabel';
  });

  if (getLabelMethod && getLabelMethod.body) {
    // Find match expression in the method
    const matchNode = findNodeByKind(getLabelMethod.body, 'match') as PhpParserTypes.Match | null;
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

/**
 * Extract the return array block from a toArray() method in PHP content.
 * This is a pure function that takes PHP source code as input.
 */
export function extractReturnArrayBlock(phpContent: string): string | null {
  const match = phpContent.match(/function\s+toArray\s*\([^)]*\)\s*:\s*array\s*\{([\s\S]*?)\n\s*\}/);
  if (!match) return null;

  const body = match[1];
  const returnMatch = body.match(/return\s*\[\s*([\s\S]*?)\s*\];/);
  if (!returnMatch) return null;

  return returnMatch[1];
}
