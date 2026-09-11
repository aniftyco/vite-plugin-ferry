import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import {
  RESOURCE_RUNTIME,
  parseMetadataDump,
  mapColumnType,
  resolveCast,
  mergeResourceFields,
  normalizeUnion,
  buildResources,
  generateResourcesDtsBlock,
  collectResourceInputs,
  type MetadataDump,
  type ResourceEntry,
} from '../src/generators/resources.js';
import { generateEnumsDts } from '../src/generators/enums.js';
import { generateRoutesDts, type RouteTable } from '../src/generators/routes.js';
import { assembleAmbientTypes } from '../src/delivery/ambient-types.js';
import { ENUM_BASE_DTS } from '../src/delivery/enum-base.js';
import type { EnumDefinition, ResourceFieldInfo } from '../src/utils/php-parser.js';
import { extractFerryAnnotations } from '../src/utils/php-parser.js';
import { dedent } from './utils.js';

const fixturesDir = join(import.meta.dirname, 'fixtures');
const require = createRequire(import.meta.url);
const tscPath = require.resolve('typescript/bin/tsc');

const metadata = parseMetadataDump(JSON.parse(readFileSync(join(fixturesDir, 'metadata-dump.json'), 'utf8')));

describe('RESOURCE_RUNTIME', () => {
  it('is an empty type-only module', () => {
    expect(RESOURCE_RUNTIME).toBe('export {};\n');
  });
});

describe('parseMetadataDump', () => {
  it('parses columns with nullability and casts from a Schema::getColumns / getCasts payload', () => {
    expect(metadata.Order.table).toBe('orders');

    const columns = Object.fromEntries(metadata.Order.columns.map((c) => [c.name, c]));
    expect(columns.id.type_name).toBe('bigint');
    expect(columns.id.nullable).toBe(false);
    expect(columns.notes.type_name).toBe('text');
    expect(columns.notes.nullable).toBe(true);

    expect(metadata.Order.casts.status).toBe('App\\Enums\\OrderStatus');
    expect(metadata.Order.casts.id).toBe('integer');
  });

  it('degrades to an empty dump on malformed input', () => {
    expect(parseMetadataDump(null)).toEqual({});
    expect(parseMetadataDump('nonsense')).toEqual({});
    expect(parseMetadataDump({ Foo: 42 })).toEqual({});
  });
});

describe('mapColumnType', () => {
  it('maps leaf types and appends | null for nullable columns', () => {
    expect(mapColumnType('bigint', false)).toBe('number');
    expect(mapColumnType('decimal', false)).toBe('number');
    expect(mapColumnType('varchar', false)).toBe('string');
    expect(mapColumnType('text', true)).toBe('string | null');
    expect(mapColumnType('boolean', false)).toBe('boolean');
    expect(mapColumnType('datetime', true)).toBe('string | null');
  });
});

describe('resolveCast', () => {
  const knownEnums = new Set(['OrderStatus']);

  it('maps a known ferry enum cast (FQCN or short) to its backing-value type and reports the enum name', () => {
    expect(resolveCast('App\\Enums\\OrderStatus', knownEnums)).toEqual({ type: 'OrderStatusValue', enum: 'OrderStatus' });
    expect(resolveCast('OrderStatus', knownEnums)).toEqual({ type: 'OrderStatusValue', enum: 'OrderStatus' });
  });

  it('marks a class cast that is NOT a known ferry enum as unresolved (no @ferry/enums import)', () => {
    // Laravel built-in class casts / custom value objects ferry never generates an enum for.
    expect(resolveCast('Illuminate\\Database\\Eloquent\\Casts\\AsCollection', knownEnums)).toEqual({
      type: '',
      unresolved: true,
    });
    expect(resolveCast('AsStringable::class', knownEnums)).toEqual({ type: '', unresolved: true });
    // A PascalCase token is not treated as an enum just because it looks like a class.
    expect(resolveCast('OrderStatus', new Set())).toEqual({ type: '', unresolved: true });
  });

  it('maps primitive casts without reporting an enum', () => {
    expect(resolveCast('integer')).toEqual({ type: 'number' });
    // `decimal:<scale>` serializes to a formatted string, not a number.
    expect(resolveCast('decimal:2')).toEqual({ type: 'string' });
    expect(resolveCast('float')).toEqual({ type: 'number' });
    expect(resolveCast('double')).toEqual({ type: 'number' });
    expect(resolveCast('boolean')).toEqual({ type: 'boolean' });
    expect(resolveCast('datetime')).toEqual({ type: 'string' });
    expect(resolveCast('array')).toEqual({ type: 'any[]' });
    expect(resolveCast('hashed')).toEqual({ type: 'string' });
  });
});

describe('normalizeUnion', () => {
  it('dedupes members and collapses null into a single trailing member, order-independent', () => {
    expect(normalizeUnion('string | string')).toBe('string');
    expect(normalizeUnion('string | null | string')).toBe('string | null');
    expect(normalizeUnion('string | string | null')).toBe('string | null');
    expect(normalizeUnion('number | string')).toBe('number | string');
    expect(normalizeUnion('null | string | null')).toBe('string | null');
  });
});

describe('mergeResourceFields', () => {
  const knownEnums = new Set(['OrderStatus']);

  it('merges static shape with metadata leaf types, composing nullability with casts and columns', () => {
    const staticFields: Record<string, ResourceFieldInfo> = {
      id: { type: 'string', optional: false, column: 'id' },
      status: { type: 'string', optional: false, column: 'status' },
      state: { type: 'string', optional: false, column: 'state' },
      settings: { type: 'any', optional: false, column: 'settings' },
      notes: { type: 'string', optional: false, column: 'notes' },
      created_at: { type: 'string', optional: false, column: 'created_at' },
    };
    const enumNames = new Set<string>();
    const warnings: string[] = [];

    const fields = mergeResourceFields({
      resourceName: 'OrderResource',
      model: 'Order',
      staticFields,
      metadata,
      annotations: {},
      strict: false,
      knownEnums,
      enumNames,
      warnings,
    });

    // cast wins: integer cast on a non-nullable id column -> number
    expect(fields.id.type).toBe('number');
    // enum cast on a non-nullable column -> the enum's backing-value type
    expect(fields.status.type).toBe('OrderStatusValue');
    // enum cast on a NULLABLE column -> the two rules compose: `OrderStatusValue | null`
    expect(fields.state.type).toBe('OrderStatusValue | null');
    expect(enumNames.has('OrderStatus')).toBe(true);
    // non-enum primitive cast (`array`) on a nullable column -> `any[] | null`
    expect(fields.settings.type).toBe('any[] | null');
    // nullable text column (no cast) -> string | null
    expect(fields.notes.type).toBe('string | null');
    // nullable datetime column (no cast) -> string | null
    expect(fields.created_at.type).toBe('string | null');
    expect(warnings).toHaveLength(0);
  });

  it('degrades a cast to a class that is NOT a known ferry enum, with no @ferry/enums import', () => {
    const enumNames = new Set<string>();
    const warnings: string[] = [];

    const fields = mergeResourceFields({
      resourceName: 'OrderResource',
      model: 'Order',
      // `payload` is cast to Illuminate's AsCollection, which ferry never generates an enum for.
      staticFields: { payload: { type: 'any', optional: false, column: 'payload' } },
      metadata,
      annotations: {},
      strict: false,
      knownEnums,
      enumNames,
      warnings,
    });

    expect(fields.payload.type).toBe('any');
    expect(enumNames.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('OrderResource.payload');
  });

  it('degrades an undecidable field to any (strict:false) with a warning naming resource + field', () => {
    const staticFields: Record<string, ResourceFieldInfo> = {
      meta: { type: 'any', optional: false, undecidable: true },
    };
    const warnings: string[] = [];

    const fields = mergeResourceFields({
      resourceName: 'OrderResource',
      model: 'Order',
      staticFields,
      metadata: {},
      annotations: {},
      strict: false,
      knownEnums,
      enumNames: new Set(),
      warnings,
    });

    expect(fields.meta.type).toBe('any');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('OrderResource.meta');
    expect(warnings[0]).toContain('@ferry meta');
  });

  it('degrades an undecidable field to unknown under strict:true', () => {
    const warnings: string[] = [];
    const fields = mergeResourceFields({
      resourceName: 'OrderResource',
      model: 'Order',
      staticFields: { meta: { type: 'any', optional: false, undecidable: true } },
      metadata: {},
      annotations: {},
      strict: true,
      knownEnums,
      enumNames: new Set(),
      warnings,
    });

    expect(fields.meta.type).toBe('unknown');
    expect(warnings).toHaveLength(1);
  });

  it('pins a cleanly-resolved field when annotated, overriding its precise inferred type', () => {
    const enumNames = new Set<string>();
    const warnings: string[] = [];

    const fields = mergeResourceFields({
      resourceName: 'OrderResource',
      model: 'Order',
      // Both resolve cleanly from metadata with no annotation: id -> number (integer cast),
      // status -> the OrderStatus enum. The annotations must still win.
      staticFields: {
        id: { type: 'string', optional: false, column: 'id' },
        status: { type: 'string', optional: false, column: 'status' },
      },
      metadata,
      annotations: { id: 'string', status: '`ORD-${number}`' },
      strict: false,
      knownEnums,
      enumNames,
      warnings,
    });

    // The annotation wins over the cleanly-inferred number/enum types, emitted verbatim.
    expect(fields.id.type).toBe('string');
    expect(fields.status.type).toBe('`ORD-${number}`');
    // Annotation short-circuits before enum resolution, so no @ferry/enums import is pulled in.
    expect(enumNames.has('OrderStatus')).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it('applies a @ferry annotation verbatim and clears the warning', () => {
    const warnings: string[] = [];
    const fields = mergeResourceFields({
      resourceName: 'OrderResource',
      model: 'Order',
      staticFields: { meta: { type: 'any', optional: false, undecidable: true } },
      metadata: {},
      annotations: { meta: 'Record<string, string>' },
      strict: false,
      knownEnums,
      enumNames: new Set(),
      warnings,
    });

    expect(fields.meta.type).toBe('Record<string, string>');
    expect(warnings).toHaveLength(0);
  });
});

describe('buildResources', () => {
  it('falls a resource that cannot be analyzed back to a Record type with a warning', () => {
    const { resources, warnings } = buildResources(
      [{ className: 'WeirdResource', model: 'Weird', staticFields: null, annotations: {}, enumNames: [] }],
      {},
      false
    );

    expect(resources.WeirdResource).toEqual({ kind: 'fallback', record: 'any' });
    expect(warnings[0]).toContain('WeirdResource');
  });

  it('uses unknown as the fallback record under strict:true', () => {
    const { resources } = buildResources(
      [{ className: 'WeirdResource', model: 'Weird', staticFields: null, annotations: {}, enumNames: [] }],
      {},
      true
    );

    expect(resources.WeirdResource).toEqual({ kind: 'fallback', record: 'unknown' });
  });

  it('never throws over an undecidable field', () => {
    expect(() =>
      buildResources(
        [
          {
            className: 'OrderResource',
            model: 'Order',
            staticFields: { meta: { type: 'any', optional: false, undecidable: true } },
            annotations: {},
            enumNames: [],
          },
        ],
        {},
        true
      )
    ).not.toThrow();
  });
});

describe('generateResourcesDtsBlock', () => {
  it('renders a declare module block importing referenced enum value types from @ferry/enums', () => {
    const resources: Record<string, ResourceEntry> = {
      OrderResource: {
        kind: 'shape',
        fields: {
          id: { type: 'number', optional: false },
          status: { type: 'OrderStatusValue', optional: false },
          author: { type: 'UserResource', optional: true },
        },
      },
    };

    const block = generateResourcesDtsBlock(resources, new Set(['OrderStatus']));

    expect(block).toBe(dedent`
      declare module '@ferry/resources' {
        import { OrderStatusValue } from '@ferry/enums';

        export type OrderResource = {
          id: number;
          status: OrderStatusValue;
          author?: UserResource;
        };
      }
    `.trimEnd());

    // The old, wrong namespace must be gone.
    expect(block).not.toContain('@app/enums');
  });

  it('emits an empty declare module block when there are no resources', () => {
    expect(generateResourcesDtsBlock({}, new Set())).toBe(`declare module '@ferry/resources' {}`);
  });

  it('omits the enum import when no field references an enum', () => {
    const resources: Record<string, ResourceEntry> = {
      UserResource: { kind: 'shape', fields: { id: { type: 'string', optional: false } } },
    };

    const block = generateResourcesDtsBlock(resources, new Set(['OrderStatus']));
    expect(block).not.toContain('import');
  });

  it('quotes a non-identifier field key so the declaration is valid TS', () => {
    const resources: Record<string, ResourceEntry> = {
      UserResource: {
        kind: 'shape',
        fields: {
          'display-name': { type: 'string', optional: false },
          id: { type: 'number', optional: false },
        },
      },
    };

    const block = generateResourcesDtsBlock(resources, new Set());
    expect(block).toContain('"display-name": string;');
    expect(block).toContain('id: number;');

    // The block compiles as real TS (a bare `display-name:` key would be a syntax error).
    const ambient = assembleAmbientTypes({ blocks: [ENUM_BASE_DTS, block] });
    const consumer = dedent`
      import type { UserResource } from '@ferry/resources';
      const u = { 'display-name': 'x', id: 1 } satisfies UserResource;
    `;
    const { ok, output } = typecheck(ambient, consumer);
    expect(ok, `tsc reported errors:\n${output}`).toBe(true);
  });
});

describe('static analysis of the resource fixtures', () => {
  const inputs = collectResourceInputs({
    resourcesDir: join(fixturesDir, 'Resources'),
    modelsDir: join(fixturesDir, 'Models'),
    enumsDir: join(fixturesDir, 'Enums'),
    cwd: fixturesDir,
  });
  const { resources, enumNames } = buildResources(inputs, {}, false);
  const block = generateResourcesDtsBlock(resources, enumNames);

  it('emits every resource as an export type inside the resources module', () => {
    expect(block).toContain(`declare module '@ferry/resources' {`);
    expect(block).toContain('export type OrderResource = {');
    expect(block).toContain('export type PostResource = {');
    expect(block).toContain('export type UserResource = {');
    expect(block).toContain('export type CommentResource = {');
  });

  it('marks whenLoaded fields optional and resolves nested resource references', () => {
    // whenLoaded('user') resolves to the optional nested resource
    expect(block).toContain('user?: UserResource;');
    // Resource::make(...) -> single, Resource::collection(...) -> array, both optional via whenLoaded
    expect(block).toContain('author?: UserResource;');
    expect(block).toContain('comments?: CommentResource[];');
    expect(block).toContain('top_voted_comment?: CommentResource;');
  });

  it('inlines a nested array shape', () => {
    expect(block).toContain('shipping_address: { street: string; city: string; zip: string };');
  });

  it('never emits the old @app/enums namespace', () => {
    expect(block).not.toContain('@app/enums');
  });
});

describe('resolved property forms (static shape + metadata merge)', () => {
  const inputs = collectResourceInputs({
    resourcesDir: join(fixturesDir, 'Resources'),
    modelsDir: join(fixturesDir, 'Models'),
    enumsDir: join(fixturesDir, 'Enums'),
    cwd: fixturesDir,
  });
  const { resources } = buildResources(inputs, metadata, false, new Set(['OrderStatus']));

  function fieldsOf(name: string): Record<string, { type: string; optional: boolean }> {
    const entry = resources[name];
    expect(entry?.kind).toBe('shape');
    return (entry as Extract<ResourceEntry, { kind: 'shape' }>).fields;
  }

  it('resolves attribute, conditional and literal forms off the @mixin model', () => {
    const f = fieldsOf('AttributeResource');

    // Bare $this->prop and $this->resource->prop -> the model column/cast type.
    expect(f.id).toEqual({ type: 'number', optional: false }); // integer cast
    expect(f.name).toEqual({ type: 'string', optional: false }); // varchar
    expect(f.joined_at).toEqual({ type: 'string', optional: false }); // datetime -> string

    // whenHas / whenNotNull (null stripped) / whenNull -> the attribute, key optional.
    expect(f.phone).toEqual({ type: 'string | null', optional: true });
    expect(f.mobile).toEqual({ type: 'string', optional: true });
    expect(f.deleted).toEqual({ type: 'string | null', optional: true });

    // Aggregates / existence -> optional scalars.
    expect(f.posts_count).toEqual({ type: 'number', optional: true });
    expect(f.orders_sum).toEqual({ type: 'number', optional: true });
    expect(f.has_avatar).toEqual({ type: 'boolean', optional: true });

    // Literals and computed scalars.
    expect(f.label).toEqual({ type: 'string', optional: false });
    expect(f.answer).toEqual({ type: 'number', optional: false });
    expect(f.flag).toEqual({ type: 'boolean', optional: false });
    expect(f.full_name).toEqual({ type: 'string', optional: false });
    expect(f.tags).toEqual({ type: 'any[]', optional: false });

    // when()/unless(): no default -> optional; explicit default -> present value | default.
    expect(f.nickname).toEqual({ type: 'string', optional: true });
    expect(f.visibility).toEqual({ type: 'number | string', optional: false });
    // A column-valued default resolves through metadata too: name (string) | score (number).
    expect(f.label_or_score).toEqual({ type: 'string | number', optional: false });
    // Two same-typed columns dedupe to a single member.
    expect(f.combined_name).toEqual({ type: 'string', optional: false });
    // A nullable member collapses to a single trailing `| null`.
    expect(f.contact).toEqual({ type: 'string | null', optional: false });
    expect(f.archived).toEqual({ type: 'string | null', optional: true });
  });

  it('resolves resource-wrapping forms, adding | null only for a nullable source column', () => {
    const f = fieldsOf('RelationsResource');

    // Nullable source column -> Resource | null; non-nullable -> Resource.
    expect(f.owner).toEqual({ type: 'UserResource | null', optional: false });
    expect(f.manager).toEqual({ type: 'UserResource', optional: false });

    // whenLoaded wrapped in make/collection -> optional resource / collection.
    expect(f.author).toEqual({ type: 'UserResource', optional: true });
    expect(f.comments).toEqual({ type: 'CommentResource[]', optional: true });
  });

  it('types whenLoaded fields by their closure return, resolving related attributes to real types', () => {
    const f = fieldsOf('LoadedResource');

    // Inline array literal -> that shape; literal scalar -> the scalar. Key-optional.
    expect(f.stats).toEqual({ type: '{ active: boolean; label: string }', optional: true });
    expect(f.kind).toEqual({ type: 'string', optional: true });

    // Related-model attributes resolve to their REAL type through the relation's metadata:
    // name -> string, age -> number (would be mis-typed as string by a name guess),
    // a decimal price column -> number. Global resolution: plain_author_name resolves too.
    expect(f.author_name).toEqual({ type: 'string', optional: true });
    expect(f.author_age).toEqual({ type: 'number', optional: true });
    expect(f.author_price).toEqual({ type: 'number', optional: true });
    expect(f.plain_author_name).toEqual({ type: 'string', optional: false });

    // Explicit default -> key present, closure | default (author.name: string | boolean).
    expect(f.author_or_flag).toEqual({ type: 'string | boolean', optional: false });

    // No-closure whenLoaded -> the relation's resource, key optional (#12 behavior).
    expect(f.user).toEqual({ type: 'UserResource', optional: true });
  });

  it('degrades an unresolvable related attribute to any with a warning, never a name guess', () => {
    const { resources, warnings } = buildResources(inputs, metadata, false, new Set(['OrderStatus']));
    const entry = resources.LoadedResource;
    expect(entry?.kind).toBe('shape');
    const f = (entry as Extract<ResourceEntry, { kind: 'shape' }>).fields;

    // The 'ghost' relation is never dumped -> degrade to any, key optional preserved.
    expect(f.ghost).toEqual({ type: 'any', optional: true });
    expect(warnings.some((w) => w.includes('LoadedResource.ghost'))).toBe(true);
  });

  it('the generated block compiles with circular relations and no skipLibCheck', () => {
    const { resources: all, enumNames } = buildResources(inputs, metadata, false, new Set(['OrderStatus']));
    const block = generateResourcesDtsBlock(all, enumNames);

    const ambient = assembleAmbientTypes({
      blocks: [ENUM_BASE_DTS, generateEnumsDts({ OrderStatus: circularOrderStatus }), block],
    });

    // CategoryResource <-> ProductResource reference each other; every sibling type a field
    // names must be in scope for tsc to resolve the block without skipLibCheck.
    const consumer = dedent`
      import type { CategoryResource, ProductResource, RelationsResource } from '@ferry/resources';
      const _c = null as unknown as CategoryResource;
      const _p = null as unknown as ProductResource;
      const _r = null as unknown as RelationsResource;
      void _c; void _p; void _r;
    `;

    const { ok, output } = typecheck(ambient, consumer, false);
    expect(ok, `tsc reported errors:\n${output}`).toBe(true);
  });
});

const circularOrderStatus: EnumDefinition = {
  name: 'OrderStatus',
  backing: 'string',
  cases: [
    { key: 'PENDING', value: 'pending' },
    { key: 'SHIPPED', value: 'shipped' },
  ],
};

describe('collectResourceInputs (recursion + duplicate short names)', () => {
  const minimalResource = (className: string) =>
    `<?php\nnamespace App;\nuse Illuminate\\Http\\Resources\\Json\\JsonResource;\nclass ${className} extends JsonResource {\n  public function toArray($request): array { return ['id' => $this->id]; }\n}\n`;

  function scratch(): { dir: string; resourcesDir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ferry-collect-'));
    const resourcesDir = join(dir, 'Resources');
    mkdirSync(resourcesDir, { recursive: true });
    return { dir, resourcesDir };
  }

  const opts = (dir: string, resourcesDir: string, strict = false) => ({
    resourcesDir,
    modelsDir: join(dir, 'Models'),
    enumsDir: join(dir, 'Enums'),
    cwd: dir,
    strict,
  });

  it('recurses into subdirectories so nested resources are collected', () => {
    const { dir, resourcesDir } = scratch();
    writeFileSync(join(resourcesDir, 'UserResource.php'), minimalResource('UserResource'), 'utf8');
    mkdirSync(join(resourcesDir, 'Admin'), { recursive: true });
    writeFileSync(join(resourcesDir, 'Admin', 'AuditResource.php'), minimalResource('AuditResource'), 'utf8');

    const names = collectResourceInputs(opts(dir, resourcesDir)).map((i) => i.className);
    expect(names).toContain('UserResource');
    expect(names).toContain('AuditResource');
  });

  it('keeps the first and warns on a duplicate short class name (non-strict)', () => {
    const { dir, resourcesDir } = scratch();
    writeFileSync(join(resourcesDir, 'UserResource.php'), minimalResource('UserResource'), 'utf8');
    mkdirSync(join(resourcesDir, 'Admin'), { recursive: true });
    writeFileSync(join(resourcesDir, 'Admin', 'UserResource.php'), minimalResource('UserResource'), 'utf8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const inputs = collectResourceInputs(opts(dir, resourcesDir));

    expect(inputs.filter((i) => i.className === 'UserResource')).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('hard-fails on a duplicate short class name under strict', () => {
    const { dir, resourcesDir } = scratch();
    writeFileSync(join(resourcesDir, 'UserResource.php'), minimalResource('UserResource'), 'utf8');
    mkdirSync(join(resourcesDir, 'Admin'), { recursive: true });
    writeFileSync(join(resourcesDir, 'Admin', 'UserResource.php'), minimalResource('UserResource'), 'utf8');

    expect(() => collectResourceInputs(opts(dir, resourcesDir, true))).toThrow(/Duplicate resource class name 'UserResource'/);
  });
});

describe('extractFerryAnnotations (via fixture-style docblock)', () => {
  it('reads one raw TS type per @ferry line, spaces preserved', () => {
    const php = dedent`
      <?php
      class OrderResource {
          /**
           * @ferry meta Record<string, string>
           * @ferry tags string[]
           */
          public function toArray($request): array
          {
              return ['meta' => $this->buildMeta(), 'tags' => $this->tags->pluck('name')];
          }
      }
    `;

    expect(extractFerryAnnotations(php)).toEqual({
      meta: 'Record<string, string>',
      tags: 'string[]',
    });
  });
});

/** Type-check `consumer` against the assembled ambient declarations, returning tsc output. */
function typecheck(ambient: string, consumer: string, skipLibCheck = true): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ferry-resources-'));

  writeFileSync(join(dir, 'ferry.d.ts'), ambient, 'utf8');
  writeFileSync(join(dir, 'consumer.ts'), consumer, 'utf8');
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'esnext',
        moduleResolution: 'bundler',
        module: 'esnext',
        skipLibCheck,
        noEmit: true,
        types: [],
      },
      files: ['ferry.d.ts', 'consumer.ts'],
    }),
    'utf8'
  );

  const result = spawnSync(process.execPath, [tscPath, '--project', join(dir, 'tsconfig.json')], {
    encoding: 'utf8',
  });

  return { ok: result.status === 0, output: (result.stdout ?? '') + (result.stderr ?? '') };
}

describe('generated resource types (tsc --noEmit consumer check)', () => {
  const orderStatus: EnumDefinition = {
    name: 'OrderStatus',
    backing: 'string',
    cases: [
      { key: 'PENDING', value: 'pending', label: 'Pending Order' },
      { key: 'SHIPPED', value: 'shipped', label: 'Shipped' },
    ],
  };

  const routeTable: RouteTable = {
    'users.show': {
      name: 'users.show',
      uri: '/users/{user}',
      method: 'get',
      params: [{ name: 'user', optional: false }],
    },
  };

  const resources: Record<string, ResourceEntry> = {
    UserResource: {
      kind: 'shape',
      fields: {
        id: { type: 'number', optional: false },
        name: { type: 'string', optional: false },
      },
    },
    OrderResource: {
      kind: 'shape',
      fields: {
        id: { type: 'number', optional: false },
        status: { type: 'OrderStatusValue', optional: false },
        state: { type: 'OrderStatusValue | null', optional: false },
        user: { type: 'UserResource', optional: true },
        notes: { type: 'string | null', optional: false },
      },
    },
  };

  const ambient = assembleAmbientTypes({
    blocks: [
      ENUM_BASE_DTS,
      generateEnumsDts({ OrderStatus: orderStatus }),
      generateRoutesDts(routeTable),
      generateResourcesDtsBlock(resources, new Set(['OrderStatus'])),
    ],
  });

  it('is a script-style ambient file (zero top-level import/export)', () => {
    const topLevel = ambient.split('\n').filter((line) => /^(import|export)\b/.test(line));
    expect(topLevel).toEqual([]);
  });

  it('type-checks a consumer comparing enum-cast fields against case backing values', () => {
    const consumer = dedent`
      import type { OrderResource, UserResource } from '@ferry/resources';
      import { OrderStatus, type OrderStatusValue } from '@ferry/enums';

      // Enum-cast fields carry the raw backing value the JSON delivers, not an instance.
      const order: OrderResource = {
        id: 1,
        status: OrderStatus.PENDING.value,
        state: null,
        notes: null,
      };

      // The field is the enum's value type; nullable columns add | null.
      const status: OrderStatusValue = order.status;
      const state: OrderStatusValue | null = order.state;
      const notes: string | null = order.notes;
      const owner: UserResource | undefined = order.user;

      // Comparing a field against a case's backing value type-checks and is true on a match.
      const matched: boolean = order.status === OrderStatus.PENDING.value;

      // A case can be compared against the raw field value via is().
      const viaIs: boolean = OrderStatus.PENDING.is(order.status);

      // routes' declarations still coexist in the same ambient file
      const url: string = route('users.show', { user: 1 }).url;

      // @ts-expect-error status is a backing value, not an OrderStatus instance
      const bad: OrderStatus = order.status;
    `;

    const { ok, output } = typecheck(ambient, consumer);
    expect(ok, `tsc reported errors:\n${output}`).toBe(true);
  });
});
