import ts from 'typescript';

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

/**
 * Print a TypeScript node to a string.
 */
export function printNode(node: ts.Node): string {
  const sourceFile = ts.createSourceFile('output.ts', '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
}

/**
 * Print multiple TypeScript nodes to a string with blank lines between them.
 */
export function printNodes(nodes: ts.Node[]): string {
  return nodes.map(printNode).join('\n\n');
}

/**
 * Create a string literal type node.
 */
export function createStringLiteral(value: string): ts.StringLiteral {
  return ts.factory.createStringLiteral(value);
}

/**
 * Create a numeric literal node.
 */
export function createNumericLiteral(value: number): ts.NumericLiteral {
  return ts.factory.createNumericLiteral(value);
}

/**
 * Create an enum declaration.
 */
export function createEnum(
  name: string,
  members: Array<{ key: string; value: string | number }>
): ts.EnumDeclaration {
  const enumMembers = members.map((m) => {
    const initializer = typeof m.value === 'number' ? createNumericLiteral(m.value) : createStringLiteral(m.value);
    return ts.factory.createEnumMember(ts.factory.createIdentifier(m.key), initializer);
  });

  return ts.factory.createEnumDeclaration(
    [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
    ts.factory.createIdentifier(name),
    enumMembers
  );
}

/**
 * Create an object literal expression.
 */
export function createObjectLiteral(
  properties: Array<{ key: string; value: ts.Expression }>,
  multiLine = true
): ts.ObjectLiteralExpression {
  const objectProperties = properties.map((p) =>
    ts.factory.createPropertyAssignment(ts.factory.createIdentifier(p.key), p.value)
  );
  return ts.factory.createObjectLiteralExpression(objectProperties, multiLine);
}

/**
 * Create a const declaration with an object literal.
 */
export function createConstObject(
  name: string,
  properties: Array<{ key: string; value: ts.Expression }>,
  multiLine = true
): ts.VariableStatement {
  const objectLiteral = createObjectLiteral(properties, multiLine);

  return ts.factory.createVariableStatement(
    [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
    ts.factory.createVariableDeclarationList(
      [ts.factory.createVariableDeclaration(ts.factory.createIdentifier(name), undefined, undefined, objectLiteral)],
      ts.NodeFlags.Const
    )
  );
}

/**
 * Create a declare const statement with a typed object.
 */
export function createDeclareConstWithType(name: string, type: ts.TypeNode): ts.VariableStatement {
  return ts.factory.createVariableStatement(
    [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword), ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)],
    ts.factory.createVariableDeclarationList(
      [ts.factory.createVariableDeclaration(ts.factory.createIdentifier(name), undefined, type, undefined)],
      ts.NodeFlags.Const
    )
  );
}

/**
 * Create a type alias declaration.
 */
export function createTypeAlias(name: string, type: ts.TypeNode): ts.TypeAliasDeclaration {
  return ts.factory.createTypeAliasDeclaration(
    [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
    ts.factory.createIdentifier(name),
    undefined,
    type
  );
}

/**
 * Create a type literal with property signatures.
 */
export function createTypeLiteral(
  properties: Array<{ name: string; type: ts.TypeNode; optional?: boolean }>
): ts.TypeLiteralNode {
  const members = properties.map((p) =>
    ts.factory.createPropertySignature(
      undefined,
      ts.factory.createIdentifier(p.name),
      p.optional ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : undefined,
      p.type
    )
  );
  return ts.factory.createTypeLiteralNode(members);
}

/**
 * Create an import type declaration.
 */
export function createImportType(names: string[], from: string): ts.ImportDeclaration {
  const importSpecifiers = names.map((name) =>
    ts.factory.createImportSpecifier(false, undefined, ts.factory.createIdentifier(name))
  );

  return ts.factory.createImportDeclaration(
    undefined,
    ts.factory.createImportClause(
      true, // isTypeOnly
      undefined,
      ts.factory.createNamedImports(importSpecifiers)
    ),
    ts.factory.createStringLiteral(from)
  );
}

/**
 * Parse a type string into a TypeNode.
 */
export function parseTypeString(typeStr: string): ts.TypeNode {
  // Handle common types
  switch (typeStr) {
    case 'string':
      return ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
    case 'number':
      return ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
    case 'boolean':
      return ts.factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
    case 'any':
      return ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
    case 'null':
      return ts.factory.createLiteralTypeNode(ts.factory.createNull());
    case 'undefined':
      return ts.factory.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword);
  }

  // Handle array types like "string[]" or "User[]"
  if (typeStr.endsWith('[]')) {
    const elementType = parseTypeString(typeStr.slice(0, -2));
    return ts.factory.createArrayTypeNode(elementType);
  }

  // Handle union types like "string | null"
  if (typeStr.includes(' | ')) {
    const types = typeStr.split(' | ').map((t) => parseTypeString(t.trim()));
    return ts.factory.createUnionTypeNode(types);
  }

  // Handle Record<K, V>
  const recordMatch = typeStr.match(/^Record<([^,]+),\s*([^>]+)>$/);
  if (recordMatch) {
    const keyType = parseTypeString(recordMatch[1].trim());
    const valueType = parseTypeString(recordMatch[2].trim());
    return ts.factory.createTypeReferenceNode(ts.factory.createIdentifier('Record'), [keyType, valueType]);
  }

  // Handle inline object types like "{ key: type; ... }"
  if (typeStr.startsWith('{') && typeStr.endsWith('}')) {
    const inner = typeStr.slice(1, -1).trim();
    if (!inner) {
      return ts.factory.createTypeLiteralNode([]);
    }
    const properties = parseObjectTypeProperties(inner);
    return createTypeLiteral(properties);
  }

  // Default to type reference (custom types like "UserResource")
  return ts.factory.createTypeReferenceNode(ts.factory.createIdentifier(typeStr), undefined);
}

/**
 * Parse object type properties from a string like "key: type; key2: type2"
 */
function parseObjectTypeProperties(inner: string): Array<{ name: string; type: ts.TypeNode; optional?: boolean }> {
  const properties: Array<{ name: string; type: ts.TypeNode; optional?: boolean }> = [];
  let depth = 0;
  let current = '';
  let i = 0;

  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '{' || ch === '<' || ch === '(') depth++;
    else if (ch === '}' || ch === '>' || ch === ')') depth--;

    if ((ch === ';' || ch === ',') && depth === 0) {
      const prop = parsePropertyString(current.trim());
      if (prop) properties.push(prop);
      current = '';
    } else {
      current += ch;
    }
    i++;
  }

  // Handle last property
  const lastProp = parsePropertyString(current.trim());
  if (lastProp) properties.push(lastProp);

  return properties;
}

/**
 * Parse a single property string like "key: type" or "key?: type"
 */
function parsePropertyString(propStr: string): { name: string; type: ts.TypeNode; optional?: boolean } | null {
  if (!propStr) return null;

  const match = propStr.match(/^([A-Za-z0-9_]+)(\?)?:\s*(.+)$/);
  if (!match) return null;

  const [, name, optional, typeStr] = match;
  return {
    name,
    type: parseTypeString(typeStr.trim()),
    optional: !!optional,
  };
}

/**
 * Create an export default statement.
 */
export function createExportDefault(expression: ts.Expression): ts.ExportAssignment {
  return ts.factory.createExportAssignment(undefined, false, expression);
}
