import ts from 'typescript';
import { existsSync } from 'node:fs';
import { join, parse, relative } from 'node:path';
import { getPhpFiles, readFileSafe, writeFileEnsureDir, cleanOutputDir } from '../utils/file.js';
import {
  extractDocblockArrayShape,
  parseResourceFieldsAst,
  type EnumDefinition,
  type ResourceFieldInfo,
} from '../utils/php-parser.js';
import { mapDocTypeToTs } from '../utils/type-mapper.js';
import {
  printNode,
  createTypeAlias,
  createImportType,
  parseTypeString,
  createTypeLiteral,
} from '../utils/ts-generator.js';
import {
  generateSourceMap,
  createSourceMapComment,
  type SourceMapping,
} from '../utils/source-map.js';

export type ResourceGeneratorOptions = {
  resourcesDir: string;
  enumsDir: string;
  modelsDir: string;
  outputDir: string;
  packageName: string;
  prettyPrint?: boolean;
  cwd: string;
};

// Re-export FieldInfo type from php-parser for backwards compatibility
export type FieldInfo = ResourceFieldInfo;

/**
 * Generate TypeScript type declaration for a single resource.
 */
export function generateSingleResourceTypeScript(
  className: string,
  fields: Record<string, ResourceFieldInfo>,
  isFallback: boolean,
  referencedEnums: Set<string>,
  phpFile?: string
): string {
  const nodes: ts.Node[] = [];

  // Find which enums this resource actually uses
  const usedEnums = new Set<string>();
  for (const info of Object.values(fields)) {
    const type = info.type || '';
    for (const enumName of referencedEnums) {
      if (type.includes(enumName)) {
        usedEnums.add(enumName);
      }
    }
  }

  // Import referenced enums from @app/enums
  if (usedEnums.size > 0) {
    const enumImports = Array.from(usedEnums).sort();
    nodes.push(createImportType(enumImports, '@app/enums'));
  }

  if (isFallback) {
    // Fallback type: Record<string, any>
    const recordType = ts.factory.createTypeReferenceNode(ts.factory.createIdentifier('Record'), [
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
    ]);
    nodes.push(createTypeAlias(className, recordType));
  } else {
    // Create type literal with all fields
    const properties = Object.keys(fields).map((key) => {
      const info = fields[key];
      return {
        name: key,
        type: parseTypeString(info.type || 'any'),
        optional: info.optional,
      };
    });
    nodes.push(createTypeAlias(className, createTypeLiteral(properties)));
  }

  const lines: string[] = [];

  // Add JSDoc with source reference
  if (phpFile) {
    lines.push(`/** @see ${phpFile} */`);
  }

  lines.push(nodes.map(printNode).join('\n\n'));

  // Add source map comment
  if (phpFile) {
    lines.push(createSourceMapComment(`${className}.d.ts.map`));
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate source map for a single resource.
 */
export function generateResourceSourceMap(
  className: string,
  fields: Record<string, ResourceFieldInfo>,
  generatedFile: string,
  phpFile: string,
  outputDir: string,
  hasEnumImports: boolean
): string {
  const mappings: SourceMapping[] = [];

  // Calculate base line (after JSDoc comment and optional import)
  let currentLine = 2; // Start after JSDoc comment
  if (hasEnumImports) {
    currentLine += 2; // Import statement + blank line
  }

  // Map each field to its source location
  const fieldKeys = Object.keys(fields);
  for (let i = 0; i < fieldKeys.length; i++) {
    const key = fieldKeys[i];
    const info = fields[key];

    if (info.loc) {
      mappings.push({
        generatedLine: currentLine + 1 + i, // +1 for the "export type X = {" line
        generatedColumn: 4, // Indented
        sourceLine: info.loc.line,
        sourceColumn: info.loc.column || 0,
      });
    }
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
 * Generate runtime JavaScript for resources.
 * Resources are type-only, so this just exports an empty object.
 */
export function generateResourceRuntime(): string {
  return 'export default {};';
}

/**
 * Generate resource type files (TypeScript declarations and runtime JavaScript).
 */
export function generateResources(options: ResourceGeneratorOptions): void {
  const { resourcesDir, enumsDir, modelsDir, outputDir, packageName, cwd } = options;

  // Clean existing generated files
  cleanOutputDir(outputDir);

  const collectedEnums: Record<string, EnumDefinition> = {};
  const resources: Record<string, Record<string, ResourceFieldInfo>> = {};
  const resourcePhpFiles: Record<string, string> = {};
  const fallbacks: string[] = [];

  if (!existsSync(resourcesDir)) {
    console.warn(`Resources directory not found: ${resourcesDir}`);
    return;
  }

  const files = getPhpFiles(resourcesDir);

  for (const file of files) {
    try {
      const filePath = join(resourcesDir, file);
      const content = readFileSafe(filePath) || '';
      const className = parse(file).name;

      // Calculate relative path from project root for source mapping
      const relativePhpPath = relative(cwd, filePath);

      const docShape = extractDocblockArrayShape(content);
      const mappedDocShape = docShape ? mapDocTypeToTsForShape(docShape) : null;

      const fields = parseResourceFieldsAst(content, {
        resourcesDir,
        modelsDir,
        enumsDir,
        docShape: mappedDocShape,
        collectedEnums,
        filePath: relativePhpPath,
      });

      if (!fields) {
        fallbacks.push(className);
        resources[className] = {};
      } else {
        resources[className] = fields;
      }
      resourcePhpFiles[className] = relativePhpPath;
    } catch (e) {
      console.warn(`Failed to parse resource file: ${file}`, e);
    }
  }

  // Track which enums are actually referenced
  const referencedEnums = new Set(Object.keys(collectedEnums));
  const resourceNames = Object.keys(resources);

  // Generate individual files for each resource
  for (const className of resourceNames) {
    const fields = resources[className];
    const isFallback = fallbacks.includes(className);
    const phpFile = resourcePhpFiles[className];

    // Check if this resource has enum imports
    const usedEnums = new Set<string>();
    for (const info of Object.values(fields)) {
      const type = info.type || '';
      for (const enumName of referencedEnums) {
        if (type.includes(enumName)) {
          usedEnums.add(enumName);
        }
      }
    }
    const hasEnumImports = usedEnums.size > 0;

    // Generate {ResourceName}.d.ts with JSDoc and source map comment
    const dtsContent = generateSingleResourceTypeScript(className, fields, isFallback, referencedEnums, phpFile);
    writeFileEnsureDir(join(outputDir, `${className}.d.ts`), dtsContent);

    // Generate {ResourceName}.d.ts.map
    if (phpFile && !isFallback) {
      const sourceMap = generateResourceSourceMap(
        className,
        fields,
        `${className}.d.ts`,
        phpFile,
        outputDir,
        hasEnumImports
      );
      writeFileEnsureDir(join(outputDir, `${className}.d.ts.map`), sourceMap);
    }

    // Generate {ResourceName}.js (empty export for type-only)
    writeFileEnsureDir(join(outputDir, `${className}.js`), 'export {};\n');
  }

  // Generate barrel index.d.ts
  const indexDts = resourceNames.map((n) => `export type { ${n} } from './${n}.js';`).join('\n') + '\n';
  writeFileEnsureDir(join(outputDir, 'index.d.ts'), indexDts);

  // Generate barrel index.js
  const indexJs = resourceNames.map((n) => `export * from './${n}.js';`).join('\n') + '\n';
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

/**
 * Map docblock types to TypeScript for each field in a shape.
 */
function mapDocTypeToTsForShape(docShape: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, type] of Object.entries(docShape)) {
    result[key] = mapDocTypeToTs(type);
  }
  return result;
}
