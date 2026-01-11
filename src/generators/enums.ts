import ts from 'typescript';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getPhpFiles, readFileSafe, writeFileEnsureDir, cleanOutputDir } from '../utils/file.js';
import { parseEnumContent, type EnumDefinition } from '../utils/php-parser.js';
import {
  createEnum,
  createConstObject,
  createObjectLiteral,
  createDeclareConstWithType,
  createTypeLiteral,
  createStringLiteral,
  createNumericLiteral,
  printNode,
} from '../utils/ts-generator.js';
import {
  generateSourceMap,
  createSourceMapComment,
  type SourceMapping,
} from '../utils/source-map.js';

export type EnumGeneratorOptions = {
  enumsDir: string;
  outputDir: string;
  packageName: string;
  prettyPrint?: boolean;
  cwd: string;
};

/**
 * Generate TypeScript type declaration for a single enum.
 */
export function generateSingleEnumTypeScript(enumDef: EnumDefinition, phpFile?: string): string {
  const hasLabels = enumDef.cases.some((c) => c.label);

  let node: ts.Node;
  if (hasLabels) {
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
    node = createDeclareConstWithType(enumDef.name, createTypeLiteral(properties));
  } else {
    node = createEnum(enumDef.name, enumDef.cases.map((c) => ({ key: c.key, value: c.value })));
  }

  const lines: string[] = [];

  // Add JSDoc with source reference
  if (phpFile) {
    lines.push(`/** @see ${phpFile} */`);
  }

  lines.push(printNode(node));

  // Add source map comment
  if (phpFile) {
    lines.push(createSourceMapComment(`${enumDef.name}.d.ts.map`));
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate source map for a single enum.
 */
export function generateEnumSourceMap(
  enumDef: EnumDefinition,
  generatedFile: string,
  phpFile: string,
  outputDir: string
): string {
  const mappings: SourceMapping[] = [];

  // Map enum declaration to its source location
  if (enumDef.loc) {
    mappings.push({
      generatedLine: 2, // Line after JSDoc comment
      generatedColumn: 0,
      sourceLine: enumDef.loc.line,
      sourceColumn: enumDef.loc.column || 0,
    });
  }

  // Map each enum case to its source location
  const hasLabels = enumDef.cases.some((c) => c.label);
  let currentLine = 3; // Start after "export enum Name {" or "export declare const Name: {"

  for (const enumCase of enumDef.cases) {
    if (enumCase.loc) {
      mappings.push({
        generatedLine: currentLine,
        generatedColumn: 4, // Indented
        sourceLine: enumCase.loc.line,
        sourceColumn: enumCase.loc.column || 0,
      });
    }
    // For labeled enums, each case takes multiple lines
    currentLine += hasLabels ? 4 : 1;
  }

  // Calculate relative path from output dir to PHP file
  const relativeSource = relative(outputDir, join(process.cwd(), phpFile)).replace(/\\/g, '/');

  return generateSourceMap({
    file: generatedFile,
    sources: [relativeSource],
    mappings,
  });
}

/**
 * Generate runtime JavaScript for a single enum.
 */
export function generateSingleEnumRuntime(enumDef: EnumDefinition, prettyPrint = true): string {
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

  return printNode(createConstObject(enumDef.name, properties)) + '\n';
}

/**
 * Collect all enum definitions from the enums directory.
 * This is a plugin-level function that handles file I/O.
 */
export function collectEnums(enumsDir: string, cwd: string): Record<string, EnumDefinition> {
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

      // Calculate relative path from project root for source mapping
      const relativePhpPath = relative(cwd, enumPath);
      const def = parseEnumContent(content, relativePhpPath);
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
  const { enumsDir, outputDir, packageName, prettyPrint = true, cwd } = options;

  // Clean existing generated files
  cleanOutputDir(outputDir);

  // Collect all enums
  const enums = collectEnums(enumsDir, cwd);
  const enumNames = Object.keys(enums);

  // Generate individual files for each enum
  for (const enumName of enumNames) {
    const enumDef = enums[enumName];
    const phpFile = enumDef.loc?.file;

    // Generate {EnumName}.d.ts with JSDoc and source map comment
    const dtsContent = generateSingleEnumTypeScript(enumDef, phpFile);
    writeFileEnsureDir(join(outputDir, `${enumName}.d.ts`), dtsContent);

    // Generate {EnumName}.d.ts.map
    if (phpFile) {
      const sourceMap = generateEnumSourceMap(enumDef, `${enumName}.d.ts`, phpFile, outputDir);
      writeFileEnsureDir(join(outputDir, `${enumName}.d.ts.map`), sourceMap);
    }

    // Generate {EnumName}.js
    const jsContent = generateSingleEnumRuntime(enumDef, prettyPrint);
    writeFileEnsureDir(join(outputDir, `${enumName}.js`), jsContent);
  }

  // Generate barrel index.d.ts
  const indexDts = enumNames.map((n) => `export { ${n} } from './${n}.js';`).join('\n') + '\n';
  writeFileEnsureDir(join(outputDir, 'index.d.ts'), indexDts);

  // Generate barrel index.js
  const indexJs = enumNames.map((n) => `export { ${n} } from './${n}.js';`).join('\n') + '\n';
  writeFileEnsureDir(join(outputDir, 'index.js'), indexJs);

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
