import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  parseEnumContent,
  parseModelCasts,
  extractDocblockArrayShape,
  parseResourceFieldsAst,
} from '../src/utils/php-parser.js';
import { dedent } from './utils.js';

const fixturesDir = join(import.meta.dirname, 'fixtures');

function readFixture(path: string): string {
  return readFileSync(join(fixturesDir, path), 'utf8');
}

describe('parseEnumContent', () => {
  it('parses enum with string backing and labels', () => {
    const content = readFixture('Enums/OrderStatus.php');
    const result = parseEnumContent(content);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('OrderStatus');
    expect(result!.backing).toBe('string');
    expect(result!.cases).toHaveLength(4);

    const pending = result!.cases.find((c) => c.key === 'PENDING');
    expect(pending).toBeDefined();
    expect(pending!.value).toBe('pending');
    expect(pending!.label).toBe('Pending Order');
  });

  it('parses enum with string backing without labels', () => {
    const content = readFixture('Enums/Role.php');
    const result = parseEnumContent(content);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('Role');
    expect(result!.backing).toBe('string');
    expect(result!.cases).toHaveLength(3);

    const admin = result!.cases.find((c) => c.key === 'ADMIN');
    expect(admin).toBeDefined();
    expect(admin!.value).toBe('admin');
    expect(admin!.label).toBeUndefined();
  });

  it('parses enum with int backing', () => {
    const content = readFixture('Enums/Priority.php');
    const result = parseEnumContent(content);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('Priority');
    expect(result!.backing).toBe('int');
  });

  it('parses unit enum (no backing type)', () => {
    const content = readFixture('Enums/Color.php');
    const result = parseEnumContent(content);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('Color');
    expect(result!.backing).toBeNull();
    expect(result!.cases).toHaveLength(3);

    const red = result!.cases.find((c) => c.key === 'RED');
    expect(red).toBeDefined();
    expect(red!.value).toBe('RED');
  });

  it('returns null for invalid PHP content', () => {
    const result = parseEnumContent('not valid php');
    expect(result).toBeNull();
  });

  it('returns null for PHP without enum', () => {
    const result = parseEnumContent('<?php class Foo {}');
    expect(result).toBeNull();
  });
});

describe('parseModelCasts', () => {
  it('parses protected $casts property', () => {
    const content = readFixture('Models/User.php');
    const result = parseModelCasts(content);

    expect(result.email_verified_at).toBe('datetime');
    expect(result.is_admin).toBe('boolean');
    expect(result.settings).toBe('array');
    expect(result.password).toBe('hashed');
  });

  it('parses protected $casts from another model', () => {
    const content = readFixture('Models/Post.php');
    const result = parseModelCasts(content);

    expect(result.is_published).toBe('boolean');
    expect(result.published_at).toBe('datetime');
    expect(result.metadata).toBe('array');
  });

  it('parses casts() method with return type annotation', () => {
    const content = readFixture('Models/Comment.php');
    const result = parseModelCasts(content);

    expect(result.is_approved).toBe('boolean');
    expect(result.approved_at).toBe('datetime');
    expect(result.likes_count).toBe('integer');
  });

  it('parses class-based casts', () => {
    const content = readFixture('Models/Order.php');
    const result = parseModelCasts(content);

    expect(result.status).toBe('OrderStatus');
    expect(result.total).toBe('decimal');
  });

  it('returns empty object for invalid PHP', () => {
    const result = parseModelCasts('not valid php');
    expect(result).toEqual({});
  });

  it('returns empty object for class without casts', () => {
    const result = parseModelCasts('<?php class Foo {}');
    expect(result).toEqual({});
  });
});

describe('extractDocblockArrayShape', () => {
  it('extracts docblock array shape (inline format)', () => {
    const content = `@return array { id: string, name: string, email: string }`;

    const result = extractDocblockArrayShape(content);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('string');
    expect(result!.name).toBe('string');
    expect(result!.email).toBe('string');
  });

  it('returns null when no docblock shape exists', () => {
    const content = dedent`
      public function toArray($request): array
      {
          return ['id' => $this->id];
      }
    `;

    const result = extractDocblockArrayShape(content);
    expect(result).toBeNull();
  });

  it('handles nested types (inline format)', () => {
    const content = `@return array { user: array { id: string, name: string }, items: array<Item> }`;

    const result = extractDocblockArrayShape(content);

    expect(result).not.toBeNull();
    expect(result!.user).toBe('array { id: string, name: string }');
    expect(result!.items).toBe('array<Item>');
  });

  it('parses multiline docblock with asterisks', () => {
    const content = dedent`
      /**
       * @return array {
       *     id: string,
       *     name: string,
       *     email: string,
       * }
       */
    `;

    const result = extractDocblockArrayShape(content);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('string');
    expect(result!.name).toBe('string');
    expect(result!.email).toBe('string');
  });

  it('extracts docblock from OrderResource fixture', () => {
    const content = readFixture('Resources/OrderResource.php');
    const result = extractDocblockArrayShape(content);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('string');
    expect(result!.total).toBe('number');
    expect(result!.status).toBe('string');
    expect(result!.items).toBe('array');
    expect(result!.created_at).toBe('string');
  });

  it('returns null for resource without docblock', () => {
    const content = readFixture('Resources/UserResource.php');
    const result = extractDocblockArrayShape(content);

    expect(result).toBeNull();
  });
});

describe('parseResourceFieldsAst', () => {
  it('parses UserResource fields using AST', () => {
    const content = readFixture('Resources/UserResource.php');
    const result = parseResourceFieldsAst(content);

    expect(result).not.toBeNull();
    expect(result).toEqual({
      id: { type: 'string', optional: false },
      name: { type: 'string', optional: false },
      email: { type: 'string', optional: false },
      is_admin: { type: 'boolean', optional: false },
      created_at: { type: 'string', optional: false },
      updated_at: { type: 'string', optional: false },
    });
  });

  it('parses PostResource with relations using AST', () => {
    const content = readFixture('Resources/PostResource.php');
    const result = parseResourceFieldsAst(content);

    expect(result).not.toBeNull();
    expect(result).toEqual({
      id: { type: 'string', optional: false },
      title: { type: 'string', optional: false },
      slug: { type: 'string', optional: false },
      is_published: { type: 'boolean', optional: false },
      has_comments: { type: 'boolean', optional: false },
      author: { type: 'UserResource[]', optional: true },
      comments: { type: 'CommentResource[]', optional: true },
      top_voted_comment: { type: 'CommentResource', optional: true },
      created_at: { type: 'string', optional: false },
    });
  });

  it('parses OrderResource with nested arrays using AST', () => {
    const content = readFixture('Resources/OrderResource.php');
    const result = parseResourceFieldsAst(content);

    expect(result).not.toBeNull();
    expect(result).toEqual({
      id: { type: 'string', optional: false },
      total: { type: 'string', optional: false },
      status: { type: 'string', optional: false },
      items: { type: 'string', optional: false },
      user: { type: 'Record<string, any>', optional: true }, // No resourcesDir, can't resolve
      shipping_address: { type: '{ street: string; city: string; zip: string }', optional: false },
      created_at: { type: 'string', optional: false },
    });
  });

  it('resolves whenLoaded to resource type when resourcesDir provided', () => {
    const content = readFixture('Resources/OrderResource.php');
    const resourcesDir = join(fixturesDir, 'Resources');
    const result = parseResourceFieldsAst(content, { resourcesDir });

    expect(result).not.toBeNull();
    expect(result!.user).toEqual({ type: 'UserResource', optional: true });
  });

  it('returns null for invalid PHP', () => {
    const result = parseResourceFieldsAst('not valid php');
    expect(result).toBeNull();
  });

  it('returns null for PHP without class', () => {
    const result = parseResourceFieldsAst('<?php echo "hello";');
    expect(result).toBeNull();
  });

  it('returns null for class without toArray method', () => {
    const result = parseResourceFieldsAst('<?php class Foo { public function bar() {} }');
    expect(result).toBeNull();
  });
});
