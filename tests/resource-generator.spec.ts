import { join, parse } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  generateResourceTypeScript,
  generateResourceRuntime,
  parseFieldsFromArrayBlock,
  type FieldInfo,
} from '../src/generators/resources.js';
import { readFileSafe, getPhpFiles } from '../src/utils/file.js';
import { extractDocblockArrayShape, extractReturnArrayBlock } from '../src/utils/php-parser.js';
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

describe('parseFieldsFromArrayBlock', () => {
  it('infers boolean type from is prefix', () => {
    const block = dedent`
      'is_admin' => $this->resource->is_admin,
      'isAdmin' => $this->resource->isAdmin,
    `;
    const fields = parseFieldsFromArrayBlock(block, 'UserResource', null, '', '', '', {});

    expect(fields.is_admin).toEqual({ type: 'boolean', optional: false });
    expect(fields.isAdmin).toEqual({ type: 'boolean', optional: false });
  });

  it('infers boolean type from has prefix', () => {
    const block = dedent`
      'has_comments' => $this->resource->has_comments,
      'hasComments' => $this->resource->hasComments,
    `;
    const fields = parseFieldsFromArrayBlock(block, 'PostResource', null, '', '', '', {});

    expect(fields.has_comments).toEqual({ type: 'boolean', optional: false });
    expect(fields.hasComments).toEqual({ type: 'boolean', optional: false });
  });

  it('infers string type from id field', () => {
    const block = `'id' => $this->resource->id,`;
    const fields = parseFieldsFromArrayBlock(block, 'UserResource', null, '', '', '', {});

    expect(fields.id).toEqual({ type: 'string', optional: false });
  });

  it('infers string type from _id suffix', () => {
    const block = dedent`
      'user_id' => $this->resource->user_id,
      'postId' => $this->resource->postId,
    `;
    const fields = parseFieldsFromArrayBlock(block, 'PostResource', null, '', '', '', {});

    expect(fields.user_id).toEqual({ type: 'string', optional: false });
    expect(fields.postId).toEqual({ type: 'string', optional: false });
  });

  it('infers string type from timestamp fields', () => {
    const block = `
      'created_at' => $this->resource->created_at,
      'updatedAt' => $this->resource->updatedAt,
      'deleted_at' => $this->resource->deleted_at,
    `;
    const fields = parseFieldsFromArrayBlock(block, 'UserResource', null, '', '', '', {});

    expect(fields.created_at).toEqual({ type: 'string', optional: false });
    expect(fields.updatedAt).toEqual({ type: 'string', optional: false });
    expect(fields.deleted_at).toEqual({ type: 'string', optional: false });
  });

  it('infers array type from Resource::collection', () => {
    const block = `'comments' => CommentResource::collection($this->resource->comments),`;
    const fields = parseFieldsFromArrayBlock(block, 'PostResource', null, '', '', '', {});

    expect(fields.comments).toEqual({ type: 'CommentResource[]', optional: false });
  });

  it('infers optional array type from Resource::collection with whenLoaded', () => {
    const block = `'comments' => CommentResource::collection($this->whenLoaded('comments')),`;
    const fields = parseFieldsFromArrayBlock(block, 'PostResource', null, '', '', '', {});

    expect(fields.comments).toEqual({ type: 'CommentResource[]', optional: true });
  });

  it('infers type from new Resource()', () => {
    const block = `'comment' => new CommentResource($this->resource->comment),`;
    const fields = parseFieldsFromArrayBlock(block, 'PostResource', null, '', '', '', {});

    expect(fields.comment).toEqual({ type: 'CommentResource', optional: false });
  });

  it('infers optional type from new Resource() with whenLoaded', () => {
    const block = `'comment' => new CommentResource($this->whenLoaded('comment')),`;
    const fields = parseFieldsFromArrayBlock(block, 'PostResource', null, '', '', '', {});

    expect(fields.comment).toEqual({ type: 'CommentResource', optional: true });
  });

  it('infers array type from Resource::make()', () => {
    const block = `'comments' => CommentResource::make($this->resource->comments),`;
    const fields = parseFieldsFromArrayBlock(block, 'PostResource', null, '', '', '', {});

    expect(fields.comments).toEqual({ type: 'CommentResource[]', optional: false });
  });

  it('infers optional array type from Resource::make() with whenLoaded', () => {
    const block = `'comments' => CommentResource::make($this->whenLoaded('comments')),`;
    const fields = parseFieldsFromArrayBlock(block, 'PostResource', null, '', '', '', {});

    expect(fields.comments).toEqual({ type: 'CommentResource[]', optional: true });
  });

  it('infers anonymous array type from Collection::collection()', () => {
    const block = `'items' => Collection::collection($this->resource->items),`;
    const fields = parseFieldsFromArrayBlock(block, 'OrderResource', null, '', '', '', {});

    expect(fields.items).toEqual({ type: 'any[]', optional: false });
  });

  it('infers anonymous array type from Collection::make()', () => {
    const block = `'items' => Collection::make($this->resource->items),`;
    const fields = parseFieldsFromArrayBlock(block, 'OrderResource', null, '', '', '', {});

    expect(fields.items).toEqual({ type: 'any[]', optional: false });
  });

  it('infers optional type from whenLoaded without Resource', () => {
    const block = `'author' => $this->whenLoaded('author'),`;
    const fields = parseFieldsFromArrayBlock(block, 'PostResource', null, '', '', '', {});

    expect(fields.author.optional).toBe(true);
  });

  it('parses nested arrays as inline object types', () => {
    const block = `
      'address' => [
          'street' => $this->resource->street,
          'city' => $this->resource->city,
      ],
    `;
    const fields = parseFieldsFromArrayBlock(block, 'UserResource', null, '', '', '', {});

    expect(fields.address.type).toBe('{ street: string; city: string }');
  });

  it('uses docblock type hints when available', () => {
    const block = `'count' => $this->resource->count,`;
    const docShape = { count: 'number' };
    const fields = parseFieldsFromArrayBlock(block, 'StatsResource', docShape, '', '', '', {});

    expect(fields.count).toEqual({ type: 'number', optional: false });
  });

  it('skips comment lines', () => {
    const block = dedent`
      // This is a comment
      'id' => $this->resource->id,
    `;
    const fields = parseFieldsFromArrayBlock(block, 'UserResource', null, '', '', '', {});

    expect(Object.keys(fields)).toEqual(['id']);
  });

  it('handles multiple fields', () => {
    const block = dedent`
      'id' => $this->resource->id,
      'name' => $this->resource->name,
      'email' => $this->resource->email,
      'is_admin' => $this->resource->is_admin,
    `;
    const fields = parseFieldsFromArrayBlock(block, 'UserResource', null, '', '', '', {});

    expect(Object.keys(fields)).toEqual(['id', 'name', 'email', 'is_admin']);
    expect(fields.id.type).toBe('string');
    expect(fields.name.type).toBe('string');
    expect(fields.email.type).toBe('string');
    expect(fields.is_admin.type).toBe('boolean');
  });
});

describe('resource generation integration', () => {
  it('collects and generates complete resource output', () => {
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
      const arrayBlock = extractReturnArrayBlock(content);

      if (!arrayBlock) {
        fallbacks.push(className);
        resources[className] = {};
      } else {
        const mappedDocShape = docShape
          ? Object.fromEntries(Object.entries(docShape).map(([k, v]) => [k, mapDocTypeToTs(v)]))
          : null;
        const fields = parseFieldsFromArrayBlock(
          arrayBlock,
          className,
          mappedDocShape,
          resourcesDir,
          modelsDir,
          enumsDir,
          {}
        );
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
          author?: UserResource[];
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
