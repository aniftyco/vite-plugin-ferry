import ts from 'typescript';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getPhpFiles, readFileSafe, writeFileEnsureDir } from '../utils/file.js';
import { parseEnumContent, type EnumDefinition } from '../utils/php-parser.js';
import {
  printNodes,
  createEnum,
  createConstObject,
  createObjectLiteral,
  createDeclareConstWithType,
  createTypeLiteral,
  createStringLiteral,
  createNumericLiteral,
  createExportDefault,
  printNode,
} from '../utils/ts-generator.js';

export type EnumGeneratorOptions = {
  enumsDir: string;
  outputDir: string;
  packageName: string;
  prettyPrint?: boolean;
};

/**
 * Generate TypeScript type declarations for enums.
 */
export function generateEnumTypeScript(enums: Record<string, EnumDefinition>): string {
  const nodes: ts.Node[] = [];

  for (const enumName of Object.keys(enums)) {
    const enumDef = enums[enumName];
    const hasLabels = enumDef.cases.some((c) => c.label);

    if (hasLabels) {
      // Generate a declare const with typed properties for enums with labels
      const properties = enumDef.cases.map((c) => ({
        name: c.key,
        type: createTypeLiteral([
          { name: 'value', type: ts.factory.createLiteralTypeNode(createStringLiteral(String(c.value))) },
          {
            name: 'label',
            type: ts.factory.createLiteralTypeNode(createStringLiteral(c.label || String(c.value))),
          },
        ]),
      }));

      nodes.push(createDeclareConstWithType(enumDef.name, createTypeLiteral(properties)));
    } else {
      // Generate a traditional enum
      nodes.push(createEnum(enumDef.name, enumDef.cases.map((c) => ({ key: c.key, value: c.value }))));
    }
  }

  return nodes.length > 0 ? printNodes(nodes) + '\n' : '';
}

/**
 * Generate runtime JavaScript for enums.
 */
export function generateEnumRuntime(enums: Record<string, EnumDefinition>, prettyPrint = true): string {
  const nodes: ts.Node[] = [];

  for (const enumName of Object.keys(enums)) {
    const enumDef = enums[enumName];
    const hasLabels = enumDef.cases.some((c) => c.label);

    const properties = enumDef.cases.map((c) => {
      let value: ts.Expression;
      if (hasLabels) {
        value = createObjectLiteral(
          [
            { key: 'value', value: createStringLiteral(String(c.value)) },
            { key: 'label', value: createStringLiteral(c.label || String(c.value)) },
          ],
          prettyPrint
        );
      } else if (typeof c.value === 'number') {
        value = createNumericLiteral(c.value);
      } else {
        value = createStringLiteral(String(c.value));
      }
      return { key: c.key, value };
    });

    nodes.push(createConstObject(enumDef.name, properties));
  }

  // Add export default {}
  nodes.push(createExportDefault(ts.factory.createObjectLiteralExpression([])));

  return nodes.map(printNode).join('\n\n') + '\n';
}

/**
 * Collect all enum definitions from the enums directory.
 * This is a plugin-level function that handles file I/O.
 */
export function collectEnums(enumsDir: string): Record<string, EnumDefinition> {
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

      const def = parseEnumContent(content);
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
 * Generate enum files (TypeScript declarations and runtime JavaScript).
 */
export function generateEnums(options: EnumGeneratorOptions): void {
  const { enumsDir, outputDir, packageName, prettyPrint = true } = options;

  // Collect all enums
  const enums = collectEnums(enumsDir);

  // Generate TypeScript declarations
  const dtsContent = generateEnumTypeScript(enums);
  const dtsPath = join(outputDir, 'index.d.ts');
  writeFileEnsureDir(dtsPath, dtsContent);

  // Generate runtime JavaScript
  const jsContent = generateEnumRuntime(enums, prettyPrint);
  const jsPath = join(outputDir, 'index.js');
  writeFileEnsureDir(jsPath, jsContent);

  // Generate package.json
  const pkgJson = JSON.stringify(
    {
      name: packageName,
      version: '0.0.0',
      main: 'index.js',
      types: 'index.d.ts',
    },
    null,
    2
  );
  const pkgPath = join(outputDir, 'package.json');
  writeFileEnsureDir(pkgPath, pkgJson);
}
