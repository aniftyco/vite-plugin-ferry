import { describe, it, expect } from 'vitest';
import {
  generateResourceTypeScript,
  generateResourceRuntime,
  parseFieldsFromArrayBlock,
  type FieldInfo,
} from '../src/generators/resources.js';
import { dedent } from './utils.js';

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
  it('preserves boolean types for is_ and has_ prefixed fields', () => {
    const resources: Record<string, Record<string, FieldInfo>> = {
      UserResource: {
        is_admin: { type: 'boolean', optional: false },
        is_verified: { type: 'boolean', optional: false },
        has_comments: { type: 'boolean', optional: false },
      },
    };

    const result = generateResourceTypeScript(resources, [], new Set());

    expect(result).toBe(dedent`
      export type UserResource = {
          is_admin: boolean;
          is_verified: boolean;
          has_comments: boolean;
      };
    `);
  });

  it('preserves string types for timestamp fields', () => {
    const resources: Record<string, Record<string, FieldInfo>> = {
      UserResource: {
        created_at: { type: 'string', optional: false },
        updated_at: { type: 'string', optional: false },
      },
    };

    const result = generateResourceTypeScript(resources, [], new Set());

    expect(result).toBe(dedent`
      export type UserResource = {
          created_at: string;
          updated_at: string;
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
  const emptyDirs = { resourcesDir: '', modelsDir: '', enumsDir: '' };

  it('infers boolean type from is_ prefix', () => {
    const block = `'is_admin' => $this->resource->is_admin,`;
    const fields = parseFieldsFromArrayBlock(block, 'UserResource', null, emptyDirs.resourcesDir, emptyDirs.modelsDir, emptyDirs.enumsDir, {});

    expect(fields.is_admin).toEqual({ type: 'boolean', optional: false });
  });

  it('infers boolean type from has_ prefix', () => {
    const block = `'has_comments' => $this->resource->has_comments,`;
    const fields = parseFieldsFromArrayBlock(block, 'PostResource', null, emptyDirs.resourcesDir, emptyDirs.modelsDir, emptyDirs.enumsDir, {});

    expect(fields.has_comments).toEqual({ type: 'boolean', optional: false });
  });

  it('infers boolean type from camelCase is/has prefix', () => {
    const block = `
      'isVerified' => $this->resource->isVerified,
      'hasSubscription' => $this->resource->hasSubscription,
    `;
    const fields = parseFieldsFromArrayBlock(block, 'UserResource', null, emptyDirs.resourcesDir, emptyDirs.modelsDir, emptyDirs.enumsDir, {});

    expect(fields.isVerified).toEqual({ type: 'boolean', optional: false });
    expect(fields.hasSubscription).toEqual({ type: 'boolean', optional: false });
  });

  it('infers string type from id field', () => {
    const block = `'id' => $this->resource->id,`;
    const fields = parseFieldsFromArrayBlock(block, 'UserResource', null, emptyDirs.resourcesDir, emptyDirs.modelsDir, emptyDirs.enumsDir, {});

    expect(fields.id).toEqual({ type: 'string', optional: false });
  });

  it('infers string type from _id suffix', () => {
    const block = `'user_id' => $this->resource->user_id,`;
    const fields = parseFieldsFromArrayBlock(block, 'PostResource', null, emptyDirs.resourcesDir, emptyDirs.modelsDir, emptyDirs.enumsDir, {});

    expect(fields.user_id).toEqual({ type: 'string', optional: false });
  });

  it('infers string type from timestamp fields', () => {
    const block = `
      'created_at' => $this->resource->created_at,
      'updated_at' => $this->resource->updated_at,
      'deleted_at' => $this->resource->deleted_at,
    `;
    const fields = parseFieldsFromArrayBlock(block, 'UserResource', null, emptyDirs.resourcesDir, emptyDirs.modelsDir, emptyDirs.enumsDir, {});

    expect(fields.created_at).toEqual({ type: 'string', optional: false });
    expect(fields.updated_at).toEqual({ type: 'string', optional: false });
    expect(fields.deleted_at).toEqual({ type: 'string', optional: false });
  });

  it('infers array type from Resource::collection', () => {
    const block = `'comments' => CommentResource::collection($this->resource->comments),`;
    const fields = parseFieldsFromArrayBlock(block, 'PostResource', null, emptyDirs.resourcesDir, emptyDirs.modelsDir, emptyDirs.enumsDir, {});

    expect(fields.comments).toEqual({ type: 'CommentResource[]', optional: false });
  });

  it('infers optional array type from Resource::collection with whenLoaded', () => {
    const block = `'comments' => CommentResource::collection($this->whenLoaded('comments')),`;
    const fields = parseFieldsFromArrayBlock(block, 'PostResource', null, emptyDirs.resourcesDir, emptyDirs.modelsDir, emptyDirs.enumsDir, {});

    expect(fields.comments).toEqual({ type: 'CommentResource[]', optional: true });
  });

  it('infers optional type from whenLoaded without Resource', () => {
    const block = `'author' => $this->whenLoaded('author'),`;
    const fields = parseFieldsFromArrayBlock(block, 'PostResource', null, emptyDirs.resourcesDir, emptyDirs.modelsDir, emptyDirs.enumsDir, {});

    expect(fields.author.optional).toBe(true);
  });

  it('parses nested arrays as inline object types', () => {
    const block = `
      'address' => [
          'street' => $this->resource->street,
          'city' => $this->resource->city,
      ],
    `;
    const fields = parseFieldsFromArrayBlock(block, 'UserResource', null, emptyDirs.resourcesDir, emptyDirs.modelsDir, emptyDirs.enumsDir, {});

    expect(fields.address.type).toBe('{ street: string; city: string }');
  });

  it('uses docblock type hints when available', () => {
    const block = `'count' => $this->resource->count,`;
    const docShape = { count: 'number' };
    const fields = parseFieldsFromArrayBlock(block, 'StatsResource', docShape, emptyDirs.resourcesDir, emptyDirs.modelsDir, emptyDirs.enumsDir, {});

    expect(fields.count).toEqual({ type: 'number', optional: false });
  });

  it('skips comment lines', () => {
    const block = `
      // This is a comment
      'id' => $this->resource->id,
    `;
    const fields = parseFieldsFromArrayBlock(block, 'UserResource', null, emptyDirs.resourcesDir, emptyDirs.modelsDir, emptyDirs.enumsDir, {});

    expect(Object.keys(fields)).toEqual(['id']);
  });

  it('handles multiple fields', () => {
    const block = `
      'id' => $this->resource->id,
      'name' => $this->resource->name,
      'email' => $this->resource->email,
      'is_admin' => $this->resource->is_admin,
    `;
    const fields = parseFieldsFromArrayBlock(block, 'UserResource', null, emptyDirs.resourcesDir, emptyDirs.modelsDir, emptyDirs.enumsDir, {});

    expect(Object.keys(fields)).toEqual(['id', 'name', 'email', 'is_admin']);
    expect(fields.id.type).toBe('string');
    expect(fields.name.type).toBe('string');
    expect(fields.email.type).toBe('string');
    expect(fields.is_admin.type).toBe('boolean');
  });
});
