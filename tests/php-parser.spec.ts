import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseEnumContent,
  parseModelCasts,
  extractDocblockArrayShape,
  extractReturnArrayBlock,
} from '../src/utils/php-parser.js';

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
    const content = `
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
    const content = `
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

describe('extractReturnArrayBlock', () => {
  it('extracts return array from toArray method', () => {
    const content = `
    public function toArray($request): array
    {
        return [
            'id' => $this->resource->id,
            'name' => $this->resource->name,
        ];
    }
    `;

    const result = extractReturnArrayBlock(content);

    expect(result).not.toBeNull();
    expect(result).toContain("'id' => $this->resource->id");
    expect(result).toContain("'name' => $this->resource->name");
  });

  it('returns null when no toArray method exists', () => {
    const content = `
    public function getData(): array
    {
        return ['id' => $this->id];
    }
    `;

    const result = extractReturnArrayBlock(content);
    expect(result).toBeNull();
  });

  it('extracts array block from UserResource fixture', () => {
    const content = readFixture('Resources/UserResource.php');
    const result = extractReturnArrayBlock(content);

    expect(result).not.toBeNull();
    expect(result).toContain("'id' => $this->resource->id");
    expect(result).toContain("'name' => $this->resource->name");
    expect(result).toContain("'email' => $this->resource->email");
    expect(result).toContain("'is_admin' => $this->resource->is_admin");
    expect(result).toContain("'created_at' => $this->resource->created_at");
    expect(result).toContain("'updated_at' => $this->resource->updated_at");
  });

  it('extracts array block from PostResource with relations', () => {
    const content = readFixture('Resources/PostResource.php');
    const result = extractReturnArrayBlock(content);

    expect(result).not.toBeNull();
    expect(result).toContain("'id' => $this->resource->id");
    expect(result).toContain('UserResource::collection');
    expect(result).toContain('CommentResource::collection');
    expect(result).toContain("whenLoaded('author')");
    expect(result).toContain("whenLoaded('comments')");
  });

  it('extracts array block with nested arrays from OrderResource', () => {
    const content = readFixture('Resources/OrderResource.php');
    const result = extractReturnArrayBlock(content);

    expect(result).not.toBeNull();
    expect(result).toContain("'shipping_address' => [");
    expect(result).toContain("'street' => $this->resource->address_street");
    expect(result).toContain("'city' => $this->resource->address_city");
    expect(result).toContain("'zip' => $this->resource->address_zip");
  });
});
