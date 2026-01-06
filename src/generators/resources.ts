import ts from 'typescript';
import { existsSync } from 'node:fs';
import { join, parse } from 'node:path';
import { getPhpFiles, readFileSafe, writeFileEnsureDir } from '../utils/file.js';
import {
  extractDocblockArrayShape,
  extractReturnArrayBlock,
  parseEnumContent,
  parseModelCasts,
  type EnumDefinition,
} from '../utils/php-parser.js';
import { mapDocTypeToTs, mapPhpTypeToTs, parseTsObjectStringToPairs } from '../utils/type-mapper.js';
import {
  printNode,
  createTypeAlias,
  createImportType,
  parseTypeString,
  createTypeLiteral,
} from '../utils/ts-generator.js';

export type ResourceGeneratorOptions = {
  resourcesDir: string;
  enumsDir: string;
  modelsDir: string;
  outputDir: string;
  packageName: string;
  prettyPrint?: boolean;
};

export type FieldInfo = {
  type: string;
  optional: boolean;
};

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
 * Infer TypeScript type from a PHP resource value expression.
 */
function inferTypeFromValue(
  value: string,
  key: string,
  resourceClass: string,
  resourcesDir: string,
  modelsDir: string,
  enumsDir: string,
  collectedEnums: Record<string, EnumDefinition>
): FieldInfo {
  let optional = false;

  // Resource collection: Resource::collection(...) or Resource::make(...)
  const collMatch = value.match(/([A-Za-z0-9_]+)::(?:collection|make)\s*\(\s*(.*?)\s*\)/);
  if (collMatch) {
    const res = collMatch[1];
    const inside = collMatch[2];
    if (inside.includes('whenLoaded(')) optional = true;
    // Collection::collection or Collection::make is an anonymous collection
    if (res === 'Collection') {
      return { type: 'any[]', optional };
    }
    // If no resourcesDir provided, trust the resource name
    // Otherwise, check if the resource file exists
    if (!resourcesDir || existsSync(join(resourcesDir, `${res}.php`))) {
      return { type: `${res}[]`, optional };
    }
    return { type: 'any[]', optional };
  }

  // Single resource instantiation: new Resource(...)
  const singleResMatch = value.match(/new\s+([A-Za-z0-9_]+)\s*\(\s*(.*?)\s*\)/);
  if (singleResMatch) {
    const res = singleResMatch[1];
    const inside = singleResMatch[2];
    if (inside.includes('whenLoaded(')) optional = true;
    // If no resourcesDir provided, trust the resource name
    // Otherwise, check if the resource file exists
    if (!resourcesDir || existsSync(join(resourcesDir, `${res}.php`))) {
      return { type: res, optional };
    }
    return { type: 'any', optional };
  }

  // whenLoaded
  const whenLoadedMatch = value.match(/whenLoaded\(\s*["']([A-Za-z0-9_]+)["']\s*\)/);
  if (whenLoadedMatch) {
    const name = whenLoadedMatch[1];
    optional = true;
    const candidate = `${name[0].toUpperCase()}${name.slice(1)}Resource`;
    const resPath = join(resourcesDir, `${candidate}.php`);
    if (existsSync(resPath)) {
      return { type: candidate, optional };
    }
    return { type: 'Record<string, any>', optional };
  }

  // $this->resource->property
  const propMatch = value.match(/\$this->resource->([A-Za-z0-9_]+)/);
  if (propMatch) {
    const prop = propMatch[1];

    // Boolean checks
    if (/\?\s*true\s*:\s*false|===\s*(true|false)|==\s*(true|false)/i.test(value)) {
      return { type: 'boolean', optional: false };
    }

    if (/\$this->resource->(is|has)[A-Za-z0-9_]*\s*\(/i.test(value)) {
      return { type: 'boolean', optional: false };
    }

    const lower = prop.toLowerCase();
    if (lower.startsWith('is_') || lower.startsWith('has_') || /^(is|has)[A-Z]/.test(prop)) {
      return { type: 'boolean', optional: false };
    }

    // IDs and UUIDs
    if (prop === 'id' || prop.endsWith('_id') || lower === 'uuid') {
      return { type: 'string', optional: false };
    }

    // Check model casts
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
              : mapCastToType(cast, enumsDir, collectedEnums);
          return { type: tsType, optional: false };
        }
      }
    }

    // Number heuristics
    if (['last4', 'count', 'total'].includes(prop) || /\d$/.test(prop)) {
      return { type: 'number', optional: false };
    }

    // String heuristics
    if (['id', 'uuid', 'slug', 'name', 'repository', 'region', 'email'].includes(prop)) {
      return { type: 'string', optional: false };
    }

    // Timestamps
    if (prop.endsWith('_at') || ['created_at', 'updated_at', 'lastActive'].includes(prop)) {
      return { type: 'string', optional: false };
    }

    return { type: 'string', optional: false };
  }

  return { type: 'any', optional: false };
}

/**
 * Parse fields from a PHP array block (from toArray() method).
 */
export function parseFieldsFromArrayBlock(
  block: string,
  resourceClass: string,
  docShape: Record<string, string> | null,
  resourcesDir: string,
  modelsDir: string,
  enumsDir: string,
  collectedEnums: Record<string, EnumDefinition>
): Record<string, FieldInfo> {
  const lines = block.split(/\r?\n/);
  const fields: Record<string, FieldInfo> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('//')) continue;

    const match = line.match(/["'](?<key>[A-Za-z0-9_]+)["']\s*=>\s*(?<value>.*?)(?:,\s*$|$)/);
    if (!match || !(match as any).groups) continue;

    const key = (match as any).groups.key;
    let value = (match as any).groups.value.trim();

    // Boolean heuristic
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith('is_') || lowerKey.startsWith('has_') || /^(is|has)[A-Z]/.test(key)) {
      fields[key] = { type: 'boolean', optional: false };
      continue;
    }

    // Handle nested arrays
    if (value.startsWith('[')) {
      let bracketDepth = (value.match(/\[/g) || []).length - (value.match(/\]/g) || []).length;
      const innerLines: string[] = [];
      const rest = value.replace(/^\[\s*/, '');
      if (rest) innerLines.push(rest);

      let j = i + 1;
      while (j < lines.length && bracketDepth > 0) {
        const l = lines[j];
        bracketDepth += (l.match(/\[/g) || []).length - (l.match(/\]/g) || []).length;
        innerLines.push(l.trim());
        j++;
      }
      i = j - 1;

      const innerBlock = innerLines.join('\n');
      const nested = parseFieldsFromArrayBlock(
        innerBlock,
        resourceClass,
        docShape,
        resourcesDir,
        modelsDir,
        enumsDir,
        collectedEnums
      );

      // Apply docblock shape if available
      if (docShape && docShape[key]) {
        const docType = docShape[key].trim();
        if (docType.startsWith('{')) {
          const docInner = parseTsObjectStringToPairs(docType);
          for (const dk of Object.keys(docInner)) {
            nested[dk] = { type: docInner[dk], optional: false };
          }
        }
      }

      const props: string[] = [];
      for (const nkey of Object.keys(nested)) {
        const ninfo = nested[nkey];
        const ntype = ninfo.type || 'any';
        const nopt = ninfo.optional ? '?' : '';
        props.push(`${nkey}${nopt}: ${ntype}`);
      }

      const inline = `{ ${props.join('; ')} }`;
      fields[key] = { type: inline, optional: false };
      continue;
    }

    // Use docblock type if available
    if (docShape && docShape[key]) {
      fields[key] = { type: docShape[key], optional: false };
      continue;
    }

    // Infer type from value
    const info = inferTypeFromValue(value, key, resourceClass, resourcesDir, modelsDir, enumsDir, collectedEnums);
    if (docShape && docShape[key] && (!info.type || info.type === 'any')) {
      info.type = docShape[key];
      info.optional = info.optional ?? false;
    }

    fields[key] = info;
  }

  return fields;
}

/**
 * Generate TypeScript type declarations for resources.
 */
export function generateResourceTypeScript(
  resources: Record<string, Record<string, FieldInfo>>,
  fallbacks: string[],
  referencedEnums: Set<string>
): string {
  const nodes: ts.Node[] = [];

  // Import referenced enums from @app/enums
  if (referencedEnums.size > 0) {
    const enumImports = Array.from(referencedEnums).sort();
    nodes.push(createImportType(enumImports, '@app/enums'));
  }

  // Generate resource types
  for (const className of Object.keys(resources)) {
    const fields = resources[className];

    if (fallbacks.includes(className)) {
      // Fallback type: Record<string, any>
      const recordType = ts.factory.createTypeReferenceNode(ts.factory.createIdentifier('Record'), [
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
      ]);
      nodes.push(createTypeAlias(className, recordType));
      continue;
    }

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

  if (nodes.length === 0) return '';

  return nodes.map(printNode).join('\n\n') + '\n';
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
  const { resourcesDir, enumsDir, modelsDir, outputDir, packageName } = options;

  const collectedEnums: Record<string, EnumDefinition> = {};
  const resources: Record<string, Record<string, FieldInfo>> = {};
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

      const docShape = extractDocblockArrayShape(content);
      const arrayBlock = extractReturnArrayBlock(content);

      if (!arrayBlock) {
        fallbacks.push(className);
        resources[className] = {};
      } else {
        const fields = parseFieldsFromArrayBlock(
          arrayBlock,
          className,
          docShape ? mapDocTypeToTsForShape(docShape) : null,
          resourcesDir,
          modelsDir,
          enumsDir,
          collectedEnums
        );
        resources[className] = fields;
      }
    } catch (e) {
      console.warn(`Failed to parse resource file: ${file}`, e);
    }
  }

  // Track which enums are actually referenced
  const referencedEnums = new Set(Object.keys(collectedEnums));

  // Generate TypeScript declarations
  const dtsContent = generateResourceTypeScript(resources, fallbacks, referencedEnums);
  const dtsPath = join(outputDir, 'index.d.ts');
  writeFileEnsureDir(dtsPath, dtsContent);

  // Generate runtime JavaScript
  const jsContent = generateResourceRuntime();
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
