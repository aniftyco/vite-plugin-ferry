import { join, parse } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  generateResourceTypeScript,
  generateResourceRuntime,
  type FieldInfo,
} from '../src/generators/resources.js';
import { readFileSafe, getPhpFiles } from '../src/utils/file.js';
import {
  extractDocblockArrayShape,
  parseResourceFieldsAst,
} from '../src/utils/php-parser.js';
import { mapDocTypeToTs } from '../src/utils/type-mapper.js';
import { dedent } from './utils.js';

const fixturesDir = join(import.meta.dirname, 'fixtures');

describe('generateResourceTypeScript', () => {
  it('generates type declarations for resources', () => {
    const resources: Record<string, Record<string, FieldInfo>> = {
      UserResource: {
        id: { type: 'string', optional: false },
        name: { type: 'string', optional: false },
        email: { type: 'string', optional: false },
        is_admin: { type: 'boolean', optional: false },
      },
    };

    const result = generateResourceTypeScript(resources, [], new Set());

    expect(result).toBe(dedent`
      export type UserResource = {
          id: string;
          name: string;
          email: string;
          is_admin: boolean;
      };
    `);
  });

  it('handles optional fields', () => {
    const resources: Record<string, Record<string, FieldInfo>> = {
      PostResource: {
        id: { type: 'string', optional: false },
        author: { type: 'UserResource', optional: true },
      },
    };

    const result = generateResourceTypeScript(resources, [], new Set());

    expect(result).toBe(dedent`
      export type PostResource = {
          id: string;
          author?: UserResource;
      };
    `);
  });

  it('generates fallback Record type for unparseable resources', () => {
    const resources: Record<string, Record<string, FieldInfo>> = {
      ComplexResource: {},
    };

    const result = generateResourceTypeScript(resources, ['ComplexResource'], new Set());

    expect(result).toBe(dedent`
      export type ComplexResource = Record<string, any>;
    `);
  });

  it('imports referenced enums', () => {
    const resources: Record<string, Record<string, FieldInfo>> = {
      OrderResource: {
        status: { type: 'OrderStatus', optional: false },
      },
    };

    const result = generateResourceTypeScript(resources, [], new Set(['OrderStatus']));

    expect(result).toBe(dedent`
      import type { OrderStatus } from "@app/enums";

      export type OrderResource = {
          status: OrderStatus;
      };
    `);
  });

  it('generates empty string when no resources', () => {
    const resources: Record<string, Record<string, FieldInfo>> = {};
    const result = generateResourceTypeScript(resources, [], new Set());

    expect(result).toBe('');
  });

  it('handles nested object types', () => {
    const resources: Record<string, Record<string, FieldInfo>> = {
      OrderResource: {
        shipping_address: { type: '{ street: string; city: string; zip: string }', optional: false },
      },
    };

    const result = generateResourceTypeScript(resources, [], new Set());

    expect(result).toBe(dedent`
      export type OrderResource = {
          shipping_address: {
              street: string;
              city: string;
              zip: string;
          };
      };
    `);
  });

  it('handles array types', () => {
    const resources: Record<string, Record<string, FieldInfo>> = {
      PostResource: {
        comments: { type: 'CommentResource[]', optional: true },
      },
    };

    const result = generateResourceTypeScript(resources, [], new Set());

    expect(result).toBe(dedent`
      export type PostResource = {
          comments?: CommentResource[];
      };
    `);
  });

  it('sorts multiple enum imports alphabetically', () => {
    const resources: Record<string, Record<string, FieldInfo>> = {
      OrderResource: {
        status: { type: 'OrderStatus', optional: false },
        priority: { type: 'Priority', optional: false },
      },
    };

    const result = generateResourceTypeScript(resources, [], new Set(['Priority', 'OrderStatus']));

    expect(result).toBe(dedent`
      import type { OrderStatus, Priority } from "@app/enums";

      export type OrderResource = {
          status: OrderStatus;
          priority: Priority;
      };
    `);
  });
});

describe('generateResourceRuntime', () => {
  it('generates empty runtime export', () => {
    const result = generateResourceRuntime();

    expect(result).toBe('export default {};');
  });
});

describe('resource type inference patterns', () => {
  it('preserves boolean types for is and has prefixed fields', () => {
    const resources: Record<string, Record<string, FieldInfo>> = {
      UserResource: {
        is_admin: { type: 'boolean', optional: false },
        isVerified: { type: 'boolean', optional: false },
        has_comments: { type: 'boolean', optional: false },
        hasShares: { type: 'boolean', optional: false },
      },
    };

    const result = generateResourceTypeScript(resources, [], new Set());

    expect(result).toBe(dedent`
      export type UserResource = {
          is_admin: boolean;
          isVerified: boolean;
          has_comments: boolean;
          hasShares: boolean;
      };
    `);
  });

  it('preserves string types for timestamp fields', () => {
    const resources: Record<string, Record<string, FieldInfo>> = {
      UserResource: {
        created_at: { type: 'string', optional: false },
        updatedAt: { type: 'string', optional: false },
      },
    };

    const result = generateResourceTypeScript(resources, [], new Set());

    expect(result).toBe(dedent`
      export type UserResource = {
          created_at: string;
          updatedAt: string;
      };
    `);
  });

  it('preserves string types for id fields', () => {
    const resources: Record<string, Record<string, FieldInfo>> = {
      UserResource: {
        id: { type: 'string', optional: false },
        user_id: { type: 'string', optional: false },
        uuid: { type: 'string', optional: false },
      },
    };

    const result = generateResourceTypeScript(resources, [], new Set());

    expect(result).toBe(dedent`
      export type UserResource = {
          id: string;
          user_id: string;
          uuid: string;
      };
    `);
  });
});

describe('resource generation integration', () => {
  it('collects and generates complete resource output using AST', () => {
    const resourcesDir = join(fixturesDir, 'Resources');
    const modelsDir = join(fixturesDir, 'Models');
    const enumsDir = join(fixturesDir, 'Enums');

    const resources: Record<string, Record<string, FieldInfo>> = {};
    const fallbacks: string[] = [];

    const files = getPhpFiles(resourcesDir);

    for (const file of files) {
      const filePath = join(resourcesDir, file);
      const content = readFileSafe(filePath) || '';
      const className = parse(file).name;

      const docShape = extractDocblockArrayShape(content);
      const mappedDocShape = docShape
        ? Object.fromEntries(Object.entries(docShape).map(([k, v]) => [k, mapDocTypeToTs(v)]))
        : null;

      const fields = parseResourceFieldsAst(content, {
        resourcesDir,
        modelsDir,
        enumsDir,
        docShape: mappedDocShape,
      });

      if (!fields) {
        fallbacks.push(className);
        resources[className] = {};
      } else {
        resources[className] = fields;
      }
    }

    const typescript = generateResourceTypeScript(resources, fallbacks, new Set());
    const runtime = generateResourceRuntime();

    expect(typescript).toBe(dedent`
      export type OrderResource = {
          id: string;
          total: number;
          status: string;
          items: any[];
          user?: UserResource;
          shipping_address: {
              street: string;
              city: string;
              zip: string;
          };
          created_at: string;
      };

      export type PostResource = {
          id: string;
          title: string;
          slug: string;
          is_published: boolean;
          has_comments: boolean;
          author?: UserResource;
          comments?: any[];
          top_voted_comment?: any;
          created_at: string;
      };

      export type UserResource = {
          id: string;
          name: string;
          email: string;
          is_admin: boolean;
          created_at: string;
          updated_at: string;
      };
    `);

    expect(runtime).toBe('export default {};');
  });
});
