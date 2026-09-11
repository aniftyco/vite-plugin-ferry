import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  parseEnumContent,
  parseModelCasts,
  extractDocblockArrayShape,
  extractMixinModel,
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
    // Check types and optionality (ignoring loc for this test)
    expect(result!.id.type).toBe('string');
    expect(result!.id.optional).toBe(false);
    expect(result!.name.type).toBe('string');
    expect(result!.email.type).toBe('string');
    expect(result!.is_admin.type).toBe('boolean');
    expect(result!.created_at.type).toBe('string');
    expect(result!.updated_at.type).toBe('string');
  });

  it('parses PostResource with relations using AST', () => {
    const content = readFixture('Resources/PostResource.php');
    const result = parseResourceFieldsAst(content);

    expect(result).not.toBeNull();
    expect(result!.id.type).toBe('string');
    expect(result!.title.type).toBe('string');
    expect(result!.slug.type).toBe('string');
    expect(result!.is_published.type).toBe('boolean');
    expect(result!.has_comments.type).toBe('boolean');
    expect(result!.author.type).toBe('UserResource');
    expect(result!.author.optional).toBe(true);
    expect(result!.comments.type).toBe('CommentResource[]');
    expect(result!.comments.optional).toBe(true);
    expect(result!.top_voted_comment.type).toBe('CommentResource');
    expect(result!.created_at.type).toBe('string');
  });

  it('parses OrderResource with nested arrays using AST', () => {
    const content = readFixture('Resources/OrderResource.php');
    const result = parseResourceFieldsAst(content);

    expect(result).not.toBeNull();
    expect(result!.id.type).toBe('string');
    expect(result!.total.type).toBe('string');
    expect(result!.status.type).toBe('string');
    expect(result!.items.type).toBe('string');
    expect(result!.user.type).toBe('Record<string, any>'); // No resourcesDir, can't resolve
    expect(result!.user.optional).toBe(true);
    expect(result!.shipping_address.type).toBe('{ street: string; city: string; zip: string }');
    expect(result!.created_at.type).toBe('string');
  });

  it('resolves whenLoaded to resource type when resourcesDir provided', () => {
    const content = readFixture('Resources/OrderResource.php');
    const resourcesDir = join(fixturesDir, 'Resources');
    const result = parseResourceFieldsAst(content, { resourcesDir });

    expect(result).not.toBeNull();
    expect(result!.user.type).toBe('UserResource');
    expect(result!.user.optional).toBe(true);
  });

  it('flattens a spread of an inline array and marks mergeWhen keys optional', () => {
    const content = readFixture('Resources/InvoiceResource.php');
    const result = parseResourceFieldsAst(content);

    expect(result).not.toBeNull();

    // Regular keyed fields still resolve.
    expect(result!.id.type).toBe('string');
    expect(result!.id.optional).toBe(false);
    expect(result!.number.type).toBe('string');
    expect(result!.number.optional).toBe(false);

    // `...['currency' => ..., 'subtotal' => ...]` — spread keys are flattened into the
    // shape and present unconditionally.
    expect(result!.currency.type).toBe('string');
    expect(result!.currency.optional).toBe(false);
    expect(result!.subtotal.type).toBe('string');
    expect(result!.subtotal.optional).toBe(false);

    // `mergeWhen($cond, ['internal_note' => ..., 'reviewed_by' => ...])` — conditional, so
    // its keys are contributed but optional.
    expect(result!.internal_note.type).toBe('string');
    expect(result!.internal_note.optional).toBe(true);
    expect(result!.reviewed_by.type).toBe('string');
    expect(result!.reviewed_by.optional).toBe(true);
  });

  it('resolves the full set of resource property forms statically', () => {
    const content = readFixture('Resources/AttributeResource.php');
    const result = parseResourceFieldsAst(content);

    expect(result).not.toBeNull();
    const r = result!;

    // Bare $this->prop and $this->resource->prop both record a source column.
    expect(r.id.column).toBe('id');
    expect(r.id.optional).toBe(false);
    expect(r.name.column).toBe('name');
    expect(r.name.optional).toBe(false);
    // A date attribute (bare) resolves to string.
    expect(r.joined_at.type).toBe('string');
    expect(r.joined_at.column).toBe('joined_at');

    // whenHas / whenNotNull / whenNull -> the attribute, key optional.
    expect(r.phone.column).toBe('phone');
    expect(r.phone.optional).toBe(true);
    expect(r.mobile.column).toBe('phone');
    expect(r.mobile.optional).toBe(true);
    expect(r.mobile.stripNull).toBe(true);
    expect(r.deleted.column).toBe('deleted_at');
    expect(r.deleted.optional).toBe(true);
    expect(r.deleted.stripNull).toBeUndefined();

    // Aggregates and existence checks -> fixed optional scalar types, no source column.
    expect(r.posts_count).toMatchObject({ type: 'number', optional: true });
    expect(r.posts_count.column).toBeUndefined();
    expect(r.orders_sum).toMatchObject({ type: 'number', optional: true });
    expect(r.has_avatar).toMatchObject({ type: 'boolean', optional: true });

    // Literals and computed scalars.
    expect(r.label).toMatchObject({ type: 'string', optional: false });
    expect(r.answer).toMatchObject({ type: 'number', optional: false });
    expect(r.flag).toMatchObject({ type: 'boolean', optional: false });
    expect(r.full_name).toMatchObject({ type: 'string', optional: false });
    expect(r.full_name.column).toBeUndefined();
    expect(r.tags.type).toBe('any[]');

    // when()/unless(): no default -> optional; explicit default -> present + union addend.
    expect(r.nickname.column).toBe('name');
    expect(r.nickname.optional).toBe(true);
    expect(r.visibility.column).toBe('score');
    expect(r.visibility.optional).toBe(false);
    expect(r.visibility.unionWith).toBe('string');
    // A column-valued default carries the default's source column so the merge resolves it.
    expect(r.label_or_score.column).toBe('name');
    expect(r.label_or_score.optional).toBe(false);
    expect(r.label_or_score.unionWithColumn).toBe('score');
    expect(r.archived.column).toBe('deleted_at');
    expect(r.archived.optional).toBe(true);
  });

  it('resolves resource-wrapping forms and their nullable source columns', () => {
    const content = readFixture('Resources/RelationsResource.php');
    const resourcesDir = join(fixturesDir, 'Resources');
    const result = parseResourceFieldsAst(content, { resourcesDir });

    expect(result).not.toBeNull();
    const r = result!;

    // new/make record the source column so the merge can add `| null` when it's nullable.
    expect(r.owner).toMatchObject({ type: 'UserResource', optional: false, nullFromColumn: 'phone' });
    expect(r.manager).toMatchObject({ type: 'UserResource', optional: false, nullFromColumn: 'name' });

    // whenLoaded wrapped in a resource -> optional resource / collection, no null source.
    expect(r.author).toMatchObject({ type: 'UserResource', optional: true });
    expect(r.author.nullFromColumn).toBeUndefined();
    expect(r.comments).toMatchObject({ type: 'CommentResource[]', optional: true });
  });

  it('degrades an unrecognized form to an undecidable any', () => {
    const content = dedent`
      <?php
      class WidgetResource {
          public function toArray($request): array
          {
              return ['meta' => $this->buildMeta($request)];
          }
      }
    `;
    const result = parseResourceFieldsAst(content);

    expect(result).not.toBeNull();
    expect(result!.meta).toMatchObject({ type: 'any', undecidable: true });
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

describe('extractMixinModel', () => {
  it('reads the model short name from an @mixin docblock', () => {
    const content = readFixture('Resources/AttributeResource.php');
    expect(extractMixinModel(content)).toBe('Account');
  });

  it('returns null when no @mixin tag is present', () => {
    const content = readFixture('Resources/UserResource.php');
    expect(extractMixinModel(content)).toBeNull();
  });
});

describe('source location tracking', () => {
  describe('parseEnumContent with filePath', () => {
    it('captures enum declaration location', () => {
      const content = readFixture('Enums/Role.php');
      const result = parseEnumContent(content, 'app/Enums/Role.php');

      expect(result).not.toBeNull();
      expect(result!.loc).toBeDefined();
      expect(result!.loc!.file).toBe('app/Enums/Role.php');
      expect(result!.loc!.line).toBeGreaterThan(0);
    });

    it('captures enum case locations', () => {
      const content = readFixture('Enums/Role.php');
      const result = parseEnumContent(content, 'app/Enums/Role.php');

      expect(result).not.toBeNull();
      expect(result!.cases.length).toBeGreaterThan(0);

      for (const enumCase of result!.cases) {
        expect(enumCase.loc).toBeDefined();
        expect(enumCase.loc!.file).toBe('app/Enums/Role.php');
        expect(enumCase.loc!.line).toBeGreaterThan(0);
      }
    });

    it('captures different line numbers for each case', () => {
      const content = readFixture('Enums/Role.php');
      const result = parseEnumContent(content, 'app/Enums/Role.php');

      expect(result).not.toBeNull();
      expect(result!.cases.length).toBeGreaterThanOrEqual(2);

      const lines = result!.cases.map((c) => c.loc!.line);
      const uniqueLines = new Set(lines);
      expect(uniqueLines.size).toBe(lines.length);
    });

    it('does not capture location when filePath is not provided', () => {
      const content = readFixture('Enums/Role.php');
      const result = parseEnumContent(content);

      expect(result).not.toBeNull();
      expect(result!.loc).toBeUndefined();
      for (const enumCase of result!.cases) {
        expect(enumCase.loc).toBeUndefined();
      }
    });
  });

  describe('parseResourceFieldsAst with filePath', () => {
    it('captures field locations', () => {
      const content = readFixture('Resources/UserResource.php');
      const result = parseResourceFieldsAst(content, {
        filePath: 'app/Http/Resources/UserResource.php',
      });

      expect(result).not.toBeNull();
      expect(result!.id.loc).toBeDefined();
      expect(result!.id.loc!.file).toBe('app/Http/Resources/UserResource.php');
      expect(result!.id.loc!.line).toBeGreaterThan(0);
    });

    it('captures different line numbers for each field', () => {
      const content = readFixture('Resources/UserResource.php');
      const result = parseResourceFieldsAst(content, {
        filePath: 'app/Http/Resources/UserResource.php',
      });

      expect(result).not.toBeNull();
      const fields = Object.values(result!);
      expect(fields.length).toBeGreaterThanOrEqual(2);

      const lines = fields.map((f) => f.loc!.line);
      const uniqueLines = new Set(lines);
      expect(uniqueLines.size).toBe(lines.length);
    });

    it('does not capture location when filePath is not provided', () => {
      const content = readFixture('Resources/UserResource.php');
      const result = parseResourceFieldsAst(content);

      expect(result).not.toBeNull();
      for (const field of Object.values(result!)) {
        expect(field.loc).toBeUndefined();
      }
    });
  });
});
