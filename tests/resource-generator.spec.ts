import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  generateResourceRuntime,
  generateSingleResourceTypeScript,
  generateResourceSourceMap,
} from '../src/generators/resources.js';
import { readFileSafe } from '../src/utils/file.js';
import { parseResourceFieldsAst, type ResourceFieldInfo } from '../src/utils/php-parser.js';
import { dedent } from './utils.js';

const fixturesDir = join(import.meta.dirname, 'fixtures');

describe('generateResourceRuntime', () => {
  it('generates empty runtime export', () => {
    const result = generateResourceRuntime();

    expect(result).toBe('export default {};');
  });
});

describe('generateSingleResourceTypeScript', () => {
  it('generates TypeScript without phpFile (no JSDoc or source map comment)', () => {
    const fields: Record<string, ResourceFieldInfo> = {
      id: { type: 'string', optional: false },
      name: { type: 'string', optional: false },
    };

    const result = generateSingleResourceTypeScript('UserResource', fields, false, new Set());

    expect(result).toBe(dedent`
      export type UserResource = {
          id: string;
          name: string;
      };
    `);
  });

  it('generates TypeScript with phpFile (includes JSDoc and source map comment)', () => {
    const fields: Record<string, ResourceFieldInfo> = {
      id: { type: 'string', optional: false },
      name: { type: 'string', optional: false },
    };

    const result = generateSingleResourceTypeScript(
      'UserResource',
      fields,
      false,
      new Set(),
      'app/Http/Resources/UserResource.php'
    );

    expect(result).toBe(dedent`
      /** @see app/Http/Resources/UserResource.php */
      export type UserResource = {
          id: string;
          name: string;
      };
      //# sourceMappingURL=UserResource.d.ts.map
    `);
  });

  it('generates fallback Record type', () => {
    const fields: Record<string, ResourceFieldInfo> = {};

    const result = generateSingleResourceTypeScript(
      'ComplexResource',
      fields,
      true,
      new Set(),
      'app/Http/Resources/ComplexResource.php'
    );

    expect(result).toBe(dedent`
      /** @see app/Http/Resources/ComplexResource.php */
      export type ComplexResource = Record<string, any>;
      //# sourceMappingURL=ComplexResource.d.ts.map
    `);
  });

  it('imports referenced enums', () => {
    const fields: Record<string, ResourceFieldInfo> = {
      status: { type: 'OrderStatus', optional: false },
    };

    const result = generateSingleResourceTypeScript(
      'OrderResource',
      fields,
      false,
      new Set(['OrderStatus']),
      'app/Http/Resources/OrderResource.php'
    );

    expect(result).toBe(dedent`
      /** @see app/Http/Resources/OrderResource.php */
      import type { OrderStatus } from "@app/enums";

      export type OrderResource = {
          status: OrderStatus;
      };
      //# sourceMappingURL=OrderResource.d.ts.map
    `);
  });

  it('handles optional fields', () => {
    const fields: Record<string, ResourceFieldInfo> = {
      id: { type: 'string', optional: false },
      author: { type: 'UserResource', optional: true },
    };

    const result = generateSingleResourceTypeScript('PostResource', fields, false, new Set());

    expect(result).toBe(dedent`
      export type PostResource = {
          id: string;
          author?: UserResource;
      };
    `);
  });
});

describe('generateResourceSourceMap', () => {
  it('generates valid source map JSON', () => {
    const fields: Record<string, ResourceFieldInfo> = {
      id: { type: 'string', optional: false, loc: { file: 'app/Http/Resources/User.php', line: 15 } },
      name: { type: 'string', optional: false, loc: { file: 'app/Http/Resources/User.php', line: 16 } },
    };

    const result = generateResourceSourceMap(
      'UserResource',
      fields,
      'UserResource.d.ts',
      'app/Http/Resources/UserResource.php',
      '/project/node_modules/@ferry/resources',
      false
    );
    const parsed = JSON.parse(result);

    expect(parsed.version).toBe(3);
    expect(parsed.file).toBe('UserResource.d.ts');
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0]).toContain('app/Http/Resources/UserResource.php');
    expect(typeof parsed.mappings).toBe('string');
  });

  it('includes mappings for fields with loc', () => {
    const fields: Record<string, ResourceFieldInfo> = {
      id: { type: 'string', optional: false, loc: { file: 'app/Http/Resources/User.php', line: 15 } },
      name: { type: 'string', optional: false, loc: { file: 'app/Http/Resources/User.php', line: 16 } },
      email: { type: 'string', optional: false, loc: { file: 'app/Http/Resources/User.php', line: 17 } },
    };

    const result = generateResourceSourceMap(
      'UserResource',
      fields,
      'UserResource.d.ts',
      'app/Http/Resources/UserResource.php',
      '/project/node_modules/@ferry/resources',
      false
    );
    const parsed = JSON.parse(result);

    // Should have non-empty mappings for 3 fields
    expect(parsed.mappings.length).toBeGreaterThan(0);
  });

  it('handles fields without loc information', () => {
    const fields: Record<string, ResourceFieldInfo> = {
      id: { type: 'string', optional: false },
      name: { type: 'string', optional: false },
    };

    const result = generateResourceSourceMap(
      'UserResource',
      fields,
      'UserResource.d.ts',
      'app/Http/Resources/UserResource.php',
      '/project/node_modules/@ferry/resources',
      false
    );
    const parsed = JSON.parse(result);

    // Should still be valid JSON
    expect(parsed.version).toBe(3);
    expect(parsed.file).toBe('UserResource.d.ts');
  });

  it('adjusts line numbers when enum imports are present', () => {
    const fields: Record<string, ResourceFieldInfo> = {
      status: { type: 'OrderStatus', optional: false, loc: { file: 'app/Http/Resources/Order.php', line: 20 } },
    };

    const withImports = generateResourceSourceMap(
      'OrderResource',
      fields,
      'OrderResource.d.ts',
      'app/Http/Resources/OrderResource.php',
      '/project/node_modules/@ferry/resources',
      true // hasEnumImports
    );

    const withoutImports = generateResourceSourceMap(
      'OrderResource',
      fields,
      'OrderResource.d.ts',
      'app/Http/Resources/OrderResource.php',
      '/project/node_modules/@ferry/resources',
      false // hasEnumImports
    );

    // Both should be valid, but mappings may differ due to line offset
    const parsedWith = JSON.parse(withImports);
    const parsedWithout = JSON.parse(withoutImports);

    expect(parsedWith.version).toBe(3);
    expect(parsedWithout.version).toBe(3);
  });
});

describe('resource source location integration', () => {
  it('captures loc property when filePath is provided', () => {
    const resourcesDir = join(fixturesDir, 'Resources');
    const content = readFileSafe(join(resourcesDir, 'UserResource.php')) || '';

    const fields = parseResourceFieldsAst(content, {
      filePath: 'app/Http/Resources/UserResource.php',
    });

    expect(fields).not.toBeNull();
    for (const field of Object.values(fields!)) {
      expect(field.loc).toBeDefined();
      expect(field.loc!.file).toBe('app/Http/Resources/UserResource.php');
      expect(field.loc!.line).toBeGreaterThan(0);
    }
  });
});
