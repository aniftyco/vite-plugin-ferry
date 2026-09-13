import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { assembleAmbientTypes } from '../src/delivery/ambient-types.js';
import { ENUM_BASE_DTS } from '../src/delivery/enum-base.js';
import { PAGINATION_BASE_DTS } from '../src/delivery/pagination-base.js';
import { generateEnumsDts } from '../src/generators/enums.js';
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
import { generateRoutesDts, type RouteTable } from '../src/generators/routes.js';
import type { EnumDefinition, ResourceFieldInfo } from '../src/utils/php-parser.js';
import { extractFerryAnnotations, parseResourceFieldsAst } from '../src/utils/php-parser.js';
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
    expect(resolveCast('App\\Enums\\OrderStatus', knownEnums)).toEqual({
      type: 'OrderStatusValue',
      enum: 'OrderStatus',
    });
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

  it('a @ferry pin over a paginatorUnresolved field clears its warning', () => {
    const warnings: string[] = [];
    const fields = mergeResourceFields({
      resourceName: 'OrderResource',
      model: 'Order',
      staticFields: {
        items: { type: 'OrderResource[]', optional: false, paginatorUnresolved: true },
      },
      metadata: {},
      annotations: { items: 'LengthAwarePaginated<OrderResource>' },
      strict: false,
      knownEnums,
      enumNames: new Set(),
      warnings,
    });

    expect(fields.items.type).toBe('LengthAwarePaginated<OrderResource>');
    expect(warnings).toHaveLength(0);
  });
});

describe('buildResources', () => {
  it('falls a resource that cannot be analyzed back to a Record type with a warning', () => {
    const { resources, warnings } = buildResources(
      [
        {
          className: 'WeirdResource',
          model: 'Weird',
          staticFields: null,
          annotations: {},
          propertyShapes: {},
          enumNames: [],
        },
      ],
      {},
      false
    );

    expect(resources.WeirdResource).toEqual({ kind: 'fallback', record: 'any' });
    expect(warnings[0]).toContain('WeirdResource');
  });

  it('uses unknown as the fallback record under strict:true', () => {
    const { resources } = buildResources(
      [
        {
          className: 'WeirdResource',
          model: 'Weird',
          staticFields: null,
          annotations: {},
          propertyShapes: {},
          enumNames: [],
        },
      ],
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
            propertyShapes: {},
            enumNames: [],
          },
        ],
        {},
        true
      )
    ).not.toThrow();
  });

  it('rewrites a bare known-enum name in a @ferry pin to its <Enum>Value backing-value union', () => {
    const { resources } = buildResources(
      [
        {
          className: 'OrderResource',
          model: 'Order',
          staticFields: {
            status: { type: 'any', optional: false },
            detail: { type: 'any', optional: false },
          },
          annotations: {
            status: 'OrderStatus',
            detail: '{ value: OrderStatus; label: string }',
          },
          propertyShapes: {},
          enumNames: [],
        },
      ],
      {},
      false,
      new Set(['OrderStatus'])
    );

    const fields = (resources.OrderResource as Extract<ResourceEntry, { kind: 'shape' }>).fields;
    // Bare name and a bare name inside an object literal both become the value union.
    expect(fields.status).toEqual({ type: 'OrderStatusValue', optional: false });
    expect(fields.detail).toEqual({ type: '{ value: OrderStatusValue; label: string }', optional: false });
  });

  it('leaves an explicit <Enum>Value pin unchanged and never double-suffixes overlapping names', () => {
    const { resources } = buildResources(
      [
        {
          className: 'OrderResource',
          model: 'Order',
          staticFields: {
            explicit: { type: 'any', optional: false },
            short: { type: 'any', optional: false },
            long: { type: 'any', optional: false },
          },
          annotations: {
            explicit: 'OrderStatusValue', // already the value form — must not become ...ValueValue
            short: 'Order', // shorter overlapping name
            long: 'OrderStatus', // longer overlapping name
          },
          propertyShapes: {},
          enumNames: [],
        },
      ],
      {},
      false,
      new Set(['Order', 'OrderStatus'])
    );

    const fields = (resources.OrderResource as Extract<ResourceEntry, { kind: 'shape' }>).fields;
    expect(fields.explicit).toEqual({ type: 'OrderStatusValue', optional: false });
    expect(fields.short).toEqual({ type: 'OrderValue', optional: false });
    expect(fields.long).toEqual({ type: 'OrderStatusValue', optional: false });
  });

  it('rewrites a bare enum identifier but leaves a same-named quoted string literal untouched', () => {
    const { resources } = buildResources(
      [
        {
          className: 'OrderResource',
          model: 'Order',
          staticFields: { mixed: { type: 'any', optional: false } },
          annotations: { mixed: "{ kind: 'OrderStatus'; value: OrderStatus }" },
          propertyShapes: {},
          enumNames: [],
        },
      ],
      {},
      false,
      new Set(['OrderStatus'])
    );

    const fields = (resources.OrderResource as Extract<ResourceEntry, { kind: 'shape' }>).fields;
    // The string-literal `'OrderStatus'` is a value, not the enum type — it must not be rewritten;
    // only the bare identifier `OrderStatus` becomes the backing-value union.
    expect(fields.mixed).toEqual({ type: "{ kind: 'OrderStatus'; value: OrderStatusValue }", optional: false });
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

    expect(block).toBe(
      dedent`
      declare module '@ferry/resources' {
        import { OrderStatusValue } from '@ferry/enums';

        export type OrderResource = {
          id: number;
          status: OrderStatusValue;
          author?: UserResource;
        };
      }
    `.trimEnd()
    );

    // The old, wrong namespace must be gone.
    expect(block).not.toContain('@app/enums');
  });

  it('imports a pinned <Enum>Value even when enumNames is empty, driving off knownEnums', () => {
    // A `@ferry` pin naming `OrderStatusValue` never populates the resolution-tracked
    // `enumNames`; the import must instead be driven off the known-enum set.
    const resources: Record<string, ResourceEntry> = {
      OrderResource: {
        kind: 'shape',
        fields: {
          id: { type: 'number', optional: false },
          status: { type: '{ value: OrderStatusValue; label: string }', optional: false },
        },
      },
    };

    const block = generateResourcesDtsBlock(resources, new Set(), new Set(['OrderStatus']));
    expect(block).toContain(`import { OrderStatusValue } from '@ferry/enums';`);
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

describe('array_merge(parent::toArray(), [...]) resolves the parent contribution + inline keys (#20)', () => {
  const inputs = collectResourceInputs({
    resourcesDir: join(fixturesDir, 'Resources'),
    modelsDir: join(fixturesDir, 'Models'),
    enumsDir: join(fixturesDir, 'Enums'),
    cwd: fixturesDir,
  });
  const { resources, warnings } = buildResources(inputs, metadata, false, new Set(['OrderStatus']));

  function mergedFields(): Record<string, { type: string; optional: boolean }> {
    const entry = resources.MergedResource;
    expect(entry?.kind).toBe('shape');
    return (entry as Extract<ResourceEntry, { kind: 'shape' }>).fields;
  }

  it('types the inline literal keys instead of bailing to Record<string, any>', () => {
    const f = mergedFields();

    // Model-backed inline keys resolve through metadata; a literal resolves statically.
    expect(f.id).toEqual({ type: 'number', optional: false });
    expect(f.name).toEqual({ type: 'string', optional: false });
    expect(f.label).toEqual({ type: 'string', optional: false });
  });

  it('seeds the parent contribution: model columns (minus $hidden) typed via metadata', () => {
    const f = mergedFields();

    // Columns the resource never names inline still surface, typed by cast-or-column.
    expect(f.first_name).toEqual({ type: 'string', optional: false });
    expect(f.last_name).toEqual({ type: 'string', optional: false });
    expect(f.score).toEqual({ type: 'number', optional: false }); // integer cast
    expect(f.joined_at).toEqual({ type: 'string', optional: false }); // datetime -> string

    // $hidden attributes are excluded from the parent contribution.
    expect(f.deleted_at).toBeUndefined();
  });

  it('seeds $appends accessors typed by the model scalar @property docblock', () => {
    const f = mergedFields();
    // getFullNameAttribute() is appended and documented `@property-read string $full_name`.
    expect(f.full_name).toEqual({ type: 'string', optional: false });
  });

  it('lets an inline key override a colliding parent column', () => {
    const f = mergedFields();
    // Parent `phone` column is nullable (string | null); the inline `'phone' => 'hidden'`
    // literal wins on collision, so the field is a bare string.
    expect(f.phone).toEqual({ type: 'string', optional: false });
  });

  it('applies a per-field @ferry pin on the merged resource', () => {
    expect(mergedFields().meta).toEqual({ type: 'Record<string, string>', optional: false });
  });

  it('produces no "could not statically analyze" warning for the merged resource', () => {
    expect(warnings.some((w) => w.includes('MergedResource') && w.includes('could not statically analyze'))).toBe(
      false
    );
  });

  it('degrades an undocumented append and warns', () => {
    // A dump advertising an append the model does not document with a scalar @property.
    const dump: MetadataDump = {
      ...metadata,
      Account: { ...metadata.Account, appends: [...(metadata.Account.appends ?? []), 'mystery'] },
    };
    const { resources: r, warnings: w } = buildResources(inputs, dump, false, new Set(['OrderStatus']));
    const f = (r.MergedResource as Extract<ResourceEntry, { kind: 'shape' }>).fields;

    expect(f.mystery).toEqual({ type: 'any', optional: false });
    expect(w.some((warning) => warning.includes('MergedResource.mystery'))).toBe(true);
  });

  it('restricts the parent contribution to a non-empty $visible whitelist', () => {
    // $visible names only id/name/score; other columns are excluded even though not hidden.
    const dump: MetadataDump = {
      ...metadata,
      Account: { ...metadata.Account, visible: ['id', 'name', 'score', 'full_name'] },
    };
    const { resources: r } = buildResources(inputs, dump, false, new Set(['OrderStatus']));
    const f = (r.MergedResource as Extract<ResourceEntry, { kind: 'shape' }>).fields;

    // Whitelisted parent columns + append are seeded.
    expect(f.score).toEqual({ type: 'number', optional: false });
    expect(f.full_name).toEqual({ type: 'string', optional: false });
    // Non-whitelisted columns are excluded from the parent contribution.
    expect(f.first_name).toBeUndefined();
    expect(f.last_name).toBeUndefined();
    expect(f.joined_at).toBeUndefined();
    // Inline keys are unaffected by $visible — they always appear.
    expect(f.label).toEqual({ type: 'string', optional: false });
    expect(f.phone).toEqual({ type: 'string', optional: false });
  });

  it('seeds all non-hidden columns when $visible is empty (no whitelist)', () => {
    // The base MergedResource/Account case: empty visible -> every non-hidden column appears.
    const f = mergedFields();
    expect(f.first_name).toEqual({ type: 'string', optional: false });
    expect(f.last_name).toEqual({ type: 'string', optional: false });
    expect(f.joined_at).toEqual({ type: 'string', optional: false });
    expect(f.deleted_at).toBeUndefined(); // still excluded by $hidden
  });

  it('falls back to inline keys only when the merged resource has no model metadata', () => {
    // No metadata for Account -> no parent contribution, no crash; inline keys still resolve.
    const { resources: r } = buildResources(inputs, {}, false, new Set(['OrderStatus']));
    const f = (r.MergedResource as Extract<ResourceEntry, { kind: 'shape' }>).fields;

    expect(f.label).toEqual({ type: 'string', optional: false });
    expect(f.first_name).toBeUndefined(); // parent columns need metadata to surface
  });
});

describe('array_merge(parent::toArray(), [...]) inherits an app parent resource, not the model shape', () => {
  const resourcesDir = join(fixturesDir, 'Resources');
  const inputs = collectResourceInputs({
    resourcesDir,
    modelsDir: join(fixturesDir, 'Models'),
    enumsDir: join(fixturesDir, 'Enums'),
    cwd: fixturesDir,
  });

  // A Session model whose raw columns are exactly what the buggy v1.5.1 path would seed. The
  // merge must NOT surface these — the parent RESOURCE emits the computed agent/location keys.
  const withSession: MetadataDump = {
    ...metadata,
    Session: {
      table: 'sessions',
      columns: [
        { name: 'id', type_name: 'varchar', nullable: false },
        { name: 'payload', type_name: 'text', nullable: false },
        { name: 'ip_address', type_name: 'varchar', nullable: true },
        { name: 'last_activity', type_name: 'integer', nullable: false },
      ],
      casts: {},
      appends: [],
      hidden: [],
      visible: [],
    },
  };

  function fieldsOf(
    name: string,
    dump: MetadataDump = withSession
  ): Record<string, { type: string; optional: boolean }> {
    const { resources } = buildResources(inputs, dump, false, new Set(['OrderStatus']));
    const entry = resources[name];
    expect(entry?.kind).toBe('shape');
    return (entry as Extract<ResourceEntry, { kind: 'shape' }>).fields;
  }

  it('inherits the parent resource computed keys plus the inline key', () => {
    const f = fieldsOf('AdminSessionResource');
    expect(f.agent).toEqual({ type: 'string', optional: false });
    expect(f.location).toEqual({ type: 'string', optional: false });
    expect(f.is_admin).toEqual({ type: 'boolean', optional: false });
  });

  it('does NOT invent the model raw columns the parent resource never emits', () => {
    const f = fieldsOf('AdminSessionResource');
    expect(f.payload).toBeUndefined();
    expect(f.ip_address).toBeUndefined();
    expect(f.last_activity).toBeUndefined();
  });

  it('resolves a multi-level chain and lets a child @ferry pin override an inherited key', () => {
    const f = fieldsOf('SuperAdminSessionResource');
    // Whole chain: SessionResource -> AdminSessionResource -> SuperAdminSessionResource.
    expect(f.location).toEqual({ type: 'string', optional: false });
    expect(f.is_admin).toEqual({ type: 'boolean', optional: false });
    expect(f.level).toEqual({ type: 'string', optional: false });
    // The child pin `@ferry agent number` overrides the parent's inherited string agent.
    expect(f.agent).toEqual({ type: 'number', optional: false });
    // Still no model columns anywhere in the chain.
    expect(f.payload).toBeUndefined();
  });

  it('keeps the vendor-base @mixin case (MergedResource) on the model-shape path (no regression)', () => {
    const f = fieldsOf('MergedResource');
    // Account model columns still seeded — the parent is JsonResource, so the model shape wins.
    expect(f.first_name).toEqual({ type: 'string', optional: false });
    expect(f.full_name).toEqual({ type: 'string', optional: false });
    expect(f.label).toEqual({ type: 'string', optional: false });
  });

  it('resolves a parent resource located in a SUBDIRECTORY, not the model shape', () => {
    // Collection is recursive; the app-vs-vendor gate keys on the collected class, not a flat
    // path — so a parent under Resources/Nested/ still counts as app-local.
    const f = fieldsOf('NestedChildResource');
    expect(f.agent).toEqual({ type: 'string', optional: false });
    expect(f.location).toEqual({ type: 'string', optional: false });
    expect(f.is_admin).toEqual({ type: 'boolean', optional: false });
    // No phantom @mixin Session columns.
    expect(f.payload).toBeUndefined();
    expect(f.ip_address).toBeUndefined();
  });

  it('pushes a degrading ancestor field warning once, not once per descendant', () => {
    const { warnings } = buildResources(inputs, withSession, false, new Set(['OrderStatus']));
    // DegradingParentResource.blob degrades; DegradingChildResource extends and merges it. The
    // ancestor resolves once (memoized), so its warning is emitted exactly once.
    const blobWarnings = warnings.filter((w) => w.includes('DegradingParentResource.blob'));
    expect(blobWarnings).toHaveLength(1);
  });
});

describe('@property array{...} shape refines an array cast (#21)', () => {
  const inputs = collectResourceInputs({
    resourcesDir: join(fixturesDir, 'Resources'),
    modelsDir: join(fixturesDir, 'Models'),
    enumsDir: join(fixturesDir, 'Enums'),
    cwd: fixturesDir,
  });

  function profileFields(metadataDump: MetadataDump): Record<string, { type: string; optional: boolean }> {
    const { resources } = buildResources(inputs, metadataDump, false, new Set(['OrderStatus']));
    const entry = resources.ProfileResource;
    expect(entry?.kind).toBe('shape');
    return (entry as Extract<ResourceEntry, { kind: 'shape' }>).fields;
  }

  it('emits the documented object literal for the array cast, via the metadata dump', () => {
    const f = profileFields(metadata);
    // settings has a documented @property array{...} shape -> object literal, not any[].
    expect(f.settings).toEqual({ type: '{ theme: string; notifications: boolean }', optional: false });
    // tags is a plain array cast with no documented shape -> stays any[].
    expect(f.tags).toEqual({ type: 'any[]', optional: false });
  });

  it('resolves the shape by the source attribute for a renamed field (output key != column)', () => {
    // 'prefs' => $this->resource->settings — the shape is keyed by `settings`, not `prefs`,
    // so the metadata path must key its refinement on the source column to find it.
    const f = profileFields(metadata);
    expect(f.prefs).toEqual({ type: '{ theme: string; notifications: boolean }', optional: false });
  });

  it('emits the documented object literal via the offline model-file path (no metadata)', () => {
    const f = profileFields({});
    expect(f.settings).toEqual({ type: '{ theme: string; notifications: boolean }', optional: false });
    expect(f.tags).toEqual({ type: 'any[]', optional: false });
  });

  it('emits optional keys for an array cast documented with an optional-key shape', () => {
    // @property array{name?: string, email?: string|null} $author -> object with `?` keys.
    const f = profileFields(metadata);
    expect(f.author).toEqual({ type: '{ name?: string; email?: string | null }', optional: false });
  });

  it('emits the optional-key object literal via the offline model-file path (no metadata)', () => {
    const f = profileFields({});
    expect(f.author).toEqual({ type: '{ name?: string; email?: string | null }', optional: false });
  });
});

describe('parameterized Laravel casts map by base name, never emit a raw token (#regression)', () => {
  const inputs = collectResourceInputs({
    resourcesDir: join(fixturesDir, 'Resources'),
    modelsDir: join(fixturesDir, 'Models'),
    enumsDir: join(fixturesDir, 'Enums'),
    cwd: fixturesDir,
  });

  // The metadata a reachable DB would dump for InvoiceLineItem: parameterized casts on real
  // columns. Lets us assert the DB path and the offline model-file path agree.
  const withInvoiceMeta: MetadataDump = {
    ...metadata,
    InvoiceLineItem: {
      table: 'invoice_line_items',
      columns: [
        { name: 'quantity', type_name: 'decimal', nullable: false, default: null },
        { name: 'billed_on', type_name: 'datetime', nullable: false, default: null },
        { name: 'secret_payload', type_name: 'text', nullable: false, default: null },
      ],
      casts: {
        quantity: 'decimal:5',
        billed_on: 'datetime:Y-m-d',
        secret_payload: 'encrypted:array',
      },
      appends: [],
      hidden: [],
      visible: [],
    },
  };

  function lineItemFields(metadataDump: MetadataDump): Record<string, { type: string; optional: boolean }> {
    const { resources } = buildResources(inputs, metadataDump, false, new Set(['OrderStatus']));
    const entry = resources.InvoiceLineItemResource;
    expect(entry?.kind).toBe('shape');
    return (entry as Extract<ResourceEntry, { kind: 'shape' }>).fields;
  }

  it('maps parameterized casts to their base type on the OFFLINE static-parse path (no metadata)', () => {
    // The path that runs in Docker/CI with no reachable DB: model-file casts only.
    const f = lineItemFields({});
    expect(f.quantity).toEqual({ type: 'string', optional: false }); // decimal:5 -> string
    expect(f.billed_on).toEqual({ type: 'string', optional: false }); // datetime:Y-m-d -> string
    expect(f.secret_payload).toEqual({ type: 'string', optional: false }); // encrypted:array -> string

    // The shipped bug emitted the raw cast token verbatim (`quantity: decimal:5;`). No field may
    // carry a colon-bearing raw token.
    for (const field of ['quantity', 'billed_on', 'secret_payload']) {
      expect(f[field].type).not.toContain(':');
    }
  });

  it('preserves a genuine inline TS object-shape cast untouched on the offline path', () => {
    const f = lineItemFields({});
    expect(f.meta).toEqual({ type: '{ label: string; score: number }', optional: false });
  });

  it('the DB-metadata path resolves parameterized casts to the same types (no divergence)', () => {
    const offline = lineItemFields({});
    const fromDb = lineItemFields(withInvoiceMeta);
    for (const field of ['quantity', 'billed_on', 'secret_payload']) {
      expect(fromDb[field]).toEqual(offline[field]);
    }
    // decimal:5 agrees at string across both paths, and matches resolveCast directly.
    expect(fromDb.quantity.type).toBe('string');
    expect(resolveCast('decimal:5')).toEqual({ type: 'string' });
  });

  it('emits a syntactically valid .d.ts block for a parameterized-cast resource (tsc --noEmit)', () => {
    const { resources, enumNames } = buildResources(inputs, {}, false, new Set(['OrderStatus']));
    const block = generateResourcesDtsBlock(resources, enumNames);
    const ambient = assembleAmbientTypes({ blocks: [ENUM_BASE_DTS, block] });

    const consumer = dedent`
      import type { InvoiceLineItemResource } from '@ferry/resources';
      const item: InvoiceLineItemResource = {
        quantity: '10.00000',
        billed_on: '2026-01-01',
        secret_payload: 'ciphertext',
        meta: { label: 'a', score: 1 },
        secret_note: 'ciphertext',
        password_digest: 'hashed',
        settings_obj: { theme: 'dark' },
        tag_list: ['a', 'b'],
        synced_moment: '2026-01-01T00:00:00Z',
      };
      void item;
    `;

    const { ok, output } = typecheck(ambient, consumer, false);
    expect(ok, `tsc reported errors:\n${output}`).toBe(true);
  });
});

describe('bare parameter-less casts agree between the offline and DB paths', () => {
  const inputs = collectResourceInputs({
    resourcesDir: join(fixturesDir, 'Resources'),
    modelsDir: join(fixturesDir, 'Models'),
    enumsDir: join(fixturesDir, 'Enums'),
    cwd: fixturesDir,
  });

  // The metadata a reachable DB would dump for InvoiceLineItem's bare (parameter-less) casts on
  // real, non-nullable columns — so any divergence is the cast mapping alone, not nullability.
  const withBareMeta: MetadataDump = {
    ...metadata,
    InvoiceLineItem: {
      table: 'invoice_line_items',
      columns: [
        { name: 'secret_note', type_name: 'text', nullable: false, default: null },
        { name: 'password_digest', type_name: 'text', nullable: false, default: null },
        { name: 'settings_obj', type_name: 'json', nullable: false, default: null },
        { name: 'tag_list', type_name: 'json', nullable: false, default: null },
        { name: 'synced_moment', type_name: 'timestamp', nullable: false, default: null },
      ],
      casts: {
        secret_note: 'encrypted',
        password_digest: 'hashed',
        settings_obj: 'object',
        tag_list: 'collection',
        synced_moment: 'timestamp',
      },
      appends: [],
      hidden: [],
      visible: [],
    },
  };

  function lineItemFields(metadataDump: MetadataDump): Record<string, { type: string; optional: boolean }> {
    const { resources } = buildResources(inputs, metadataDump, false, new Set(['OrderStatus']));
    const entry = resources.InvoiceLineItemResource;
    expect(entry?.kind).toBe('shape');
    return (entry as Extract<ResourceEntry, { kind: 'shape' }>).fields;
  }

  const bareFields = ['secret_note', 'password_digest', 'settings_obj', 'tag_list', 'synced_moment'] as const;

  const expected: Record<(typeof bareFields)[number], string> = {
    secret_note: 'string',
    password_digest: 'string',
    settings_obj: 'Record<string, any>',
    tag_list: 'any[]',
    synced_moment: 'string',
  };

  it('resolves bare built-in casts to concrete types on the OFFLINE path (no metadata)', () => {
    const f = lineItemFields({});
    for (const field of bareFields) {
      // Reverting the offline fix makes these degrade to `any`, failing this assertion.
      expect(f[field]).toEqual({ type: expected[field], optional: false });
    }
  });

  it('produces IDENTICAL types on the offline and DB-metadata paths', () => {
    const offline = lineItemFields({});
    const fromDb = lineItemFields(withBareMeta);
    for (const field of bareFields) {
      expect(fromDb[field]).toEqual(offline[field]);
      expect(offline[field].type).toBe(expected[field]);
    }
  });

  it('leaves enum/class casts and inline TS-shape casts unchanged on the offline path', () => {
    const f = lineItemFields({});
    // Inline TS-shape cast passes through verbatim.
    expect(f.meta).toEqual({ type: '{ label: string; score: number }', optional: false });

    // An enum/class cast resolves through enum lookup to the `<Enum>Value` backing-value union
    // (not mapBaseCastToTs, and not the bare enum class name).
    const orderContent = readFileSync(join(fixturesDir, 'Resources', 'OrderResource.php'), 'utf8');
    const orderFields = parseResourceFieldsAst(orderContent, {
      resourcesDir: join(fixturesDir, 'Resources'),
      modelsDir: join(fixturesDir, 'Models'),
      enumsDir: join(fixturesDir, 'Enums'),
    });
    expect(orderFields?.status.type).toBe('OrderStatusValue');
  });
});

describe('offline enum-cast column resolves to the <Enum>Value union (not the bare enum name)', () => {
  // An enum-cast column whose type comes PURELY from the cast — no `@return`/`@ferry` docblock to
  // mask it — on the OFFLINE path (empty metadata). The `@mixin` fixes the backing model without
  // seeding a docblock shape. Before the fix this typed as the bare `OrderStatus`, which the
  // `${enum}Value` import scan never imports (→ `Cannot find name 'OrderStatus'`) and which
  // disagrees with the DB path and pins (both `OrderStatusValue`).
  const statusEnum: EnumDefinition = {
    name: 'OrderStatus',
    backing: 'string',
    cases: [
      { key: 'PENDING', value: 'pending' },
      { key: 'SHIPPED', value: 'shipped' },
    ],
  };

  function scratchInputs() {
    const dir = mkdtempSync(join(tmpdir(), 'ferry-enum-cast-'));
    const resourcesDir = join(dir, 'Resources');
    const modelsDir = join(dir, 'Models');
    const enumsDir = join(dir, 'Enums');
    mkdirSync(resourcesDir, { recursive: true });
    mkdirSync(modelsDir, { recursive: true });
    mkdirSync(enumsDir, { recursive: true });

    writeFileSync(
      join(enumsDir, 'OrderStatus.php'),
      "<?php\nnamespace App\\Enums;\nenum OrderStatus: string {\n  case PENDING = 'pending';\n  case SHIPPED = 'shipped';\n}\n",
      'utf8'
    );
    writeFileSync(
      join(modelsDir, 'Order.php'),
      '<?php\nnamespace App\\Models;\nuse App\\Enums\\OrderStatus;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Order extends Model {\n  protected $casts = ["status" => OrderStatus::class];\n}\n',
      'utf8'
    );
    // No @return/@ferry mask — status' type comes only from the model cast.
    writeFileSync(
      join(resourcesDir, 'OrderStatusCastResource.php'),
      '<?php\nnamespace App\\Http\\Resources;\nuse Illuminate\\Http\\Request;\nuse Illuminate\\Http\\Resources\\Json\\JsonResource;\n/**\n * @mixin \\App\\Models\\Order\n */\nclass OrderStatusCastResource extends JsonResource {\n  public function toArray(Request $request): array {\n    return ["status" => $this->resource->status];\n  }\n}\n',
      'utf8'
    );

    return collectResourceInputs({ resourcesDir, modelsDir, enumsDir, cwd: dir });
  }

  const inputs = scratchInputs();
  const knownEnums = new Set(['OrderStatus']);

  const orderMeta: MetadataDump = {
    Order: {
      table: 'orders',
      columns: [{ name: 'status', type_name: 'varchar', nullable: false, default: null }],
      casts: { status: 'App\\Enums\\OrderStatus' },
      appends: [],
      hidden: [],
      visible: [],
    },
  };

  function statusField(metadataDump: MetadataDump): { type: string; optional: boolean } {
    const { resources } = buildResources(inputs, metadataDump, false, knownEnums);
    const entry = resources.OrderStatusCastResource;
    expect(entry?.kind).toBe('shape');
    return (entry as Extract<ResourceEntry, { kind: 'shape' }>).fields.status;
  }

  it('types the enum-cast column as the <Enum>Value union on the offline path', () => {
    // Reverting the fix makes this the bare `OrderStatus`, failing here.
    expect(statusField({})).toEqual({ type: 'OrderStatusValue', optional: false });
  });

  it('imports OrderStatusValue into the generated @ferry/resources block', () => {
    const { resources, enumNames } = buildResources(inputs, {}, false, knownEnums);
    const block = generateResourcesDtsBlock(resources, enumNames);
    expect(block).toContain(`import { OrderStatusValue } from '@ferry/enums';`);
    // The bare enum name is never referenced (that was the unimported, undefined identifier).
    expect(block).not.toMatch(/\bstatus: OrderStatus\b(?!Value)/);
  });

  it('agrees with the DB-metadata path (offline == DB)', () => {
    const offline = statusField({});
    const fromDb = statusField(orderMeta);
    expect(fromDb).toEqual(offline);
    expect(fromDb.type).toBe('OrderStatusValue');
  });

  it('compiles: the offline block references only the imported OrderStatusValue (tsc --noEmit)', () => {
    const { resources, enumNames } = buildResources(inputs, {}, false, knownEnums);
    const block = generateResourcesDtsBlock(resources, enumNames);
    const ambient = assembleAmbientTypes({
      blocks: [ENUM_BASE_DTS, generateEnumsDts({ OrderStatus: statusEnum }), block],
    });

    const consumer = dedent`
      import type { OrderStatusCastResource } from '@ferry/resources';
      const r = {} as OrderStatusCastResource;
      const s: 'pending' | 'shipped' = r.status;
      void s;
    `;

    // skipLibCheck=false so the block itself is checked — a bare, unimported enum name would error.
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

    expect(() => collectResourceInputs(opts(dir, resourcesDir, true))).toThrow(
      /Duplicate resource class name 'UserResource'/
    );
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

describe('a pinned <Enum>Value resolves to the real union, not any (tsc --noEmit)', () => {
  const orderStatus: EnumDefinition = {
    name: 'OrderStatus',
    backing: 'string',
    cases: [
      { key: 'PENDING', value: 'pending', label: 'Pending Order' },
      { key: 'SHIPPED', value: 'shipped', label: 'Shipped' },
    ],
  };

  // The natural pin form: an object literal whose text names the enum's backing-value union.
  // `enumNames` is EMPTY (a pin never resolves through it); only `knownEnums` carries OrderStatus.
  const resources: Record<string, ResourceEntry> = {
    OrderResource: {
      kind: 'shape',
      fields: {
        id: { type: 'number', optional: false },
        status: { type: '{ value: OrderStatusValue; label: string }', optional: false },
      },
    },
  };

  const ambient = assembleAmbientTypes({
    blocks: [
      ENUM_BASE_DTS,
      generateEnumsDts({ OrderStatus: orderStatus }),
      generateResourcesDtsBlock(resources, new Set(), new Set(['OrderStatus'])),
    ],
  });

  it('imports the pinned OrderStatusValue into the @ferry/resources block', () => {
    expect(ambient).toContain(`import { OrderStatusValue } from '@ferry/enums';`);
  });

  it('types the pinned field, so a wrong value assignment errors (proving it is not any)', () => {
    // skipLibCheck stays true (the default that hides the silent-any bug in real projects);
    // the assignment must still be caught because the type resolves inside the same block.
    const consumer = dedent`
      import type { OrderResource } from '@ferry/resources';

      declare const order: OrderResource;

      // A correct backing value assigns cleanly.
      const value: string = order.status.value;

      // @ts-expect-error 'BOGUS' is outside the OrderStatusValue backing-value union.
      // Were the field silently \`any\`, this directive would be unused and tsc would fail (TS2578).
      order.status.value = 'BOGUS';
    `;

    const { ok, output } = typecheck(ambient, consumer);
    expect(ok, `tsc reported errors:\n${output}`).toBe(true);
  });
});

describe('a bare enum-name pin resolves to its value union end-to-end (tsc --noEmit)', () => {
  const orderStatus: EnumDefinition = {
    name: 'OrderStatus',
    backing: 'string',
    cases: [
      { key: 'PENDING', value: 'pending', label: 'Pending Order' },
      { key: 'SHIPPED', value: 'shipped', label: 'Shipped' },
    ],
  };

  // A human writes the bare enum class name in the pin; the rewrite turns it into the value union.
  const { resources } = buildResources(
    [
      {
        className: 'OrderResource',
        model: 'Order',
        staticFields: { status: { type: 'any', optional: false } },
        annotations: { status: 'OrderStatus' },
        propertyShapes: {},
        enumNames: [],
      },
    ],
    {},
    false,
    new Set(['OrderStatus'])
  );

  const ambient = assembleAmbientTypes({
    blocks: [
      ENUM_BASE_DTS,
      generateEnumsDts({ OrderStatus: orderStatus }),
      generateResourcesDtsBlock(resources, new Set(), new Set(['OrderStatus'])),
    ],
  });

  it('emits OrderStatusValue and imports it', () => {
    expect(ambient).toContain('status: OrderStatusValue;');
    expect(ambient).toContain(`import { OrderStatusValue } from '@ferry/enums';`);
  });

  it('types the field, so a wrong value assignment errors (proving it is not any)', () => {
    const consumer = dedent`
      import type { OrderResource } from '@ferry/resources';
      declare const order: OrderResource;

      // @ts-expect-error 'BOGUS' is outside the OrderStatusValue backing-value union.
      order.status = 'BOGUS';
    `;
    const { ok, output } = typecheck(ambient, consumer);
    expect(ok, `tsc reported errors:\n${output}`).toBe(true);
  });
});

describe('Resource::collection(...) over a paginator emits the envelope, not Item[] (issue #27)', () => {
  function scratch(): { dir: string; resourcesDir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ferry-pagination-'));
    const resourcesDir = join(dir, 'Resources');
    mkdirSync(resourcesDir, { recursive: true });
    return { dir, resourcesDir };
  }

  function writeOrderResource(resourcesDir: string, expr: string): void {
    writeFileSync(
      join(resourcesDir, 'UserResource.php'),
      dedent`
        <?php
        namespace App\\Http\\Resources;
        use Illuminate\\Http\\Resources\\Json\\JsonResource;
        class UserResource extends JsonResource {
            public function toArray($request): array { return ['id' => $this->id]; }
        }
      `,
      'utf8'
    );
    writeFileSync(
      join(resourcesDir, 'OrderResource.php'),
      dedent`
        <?php
        namespace App\\Http\\Resources;
        use Illuminate\\Http\\Resources\\Json\\JsonResource;
        class OrderResource extends JsonResource {
            public function toArray($request): array {
                return ['users' => UserResource::collection(${expr})];
            }
        }
      `,
      'utf8'
    );
  }

  function buildBlock(expr: string): { block: string; warnings: string[] } {
    const { dir, resourcesDir } = scratch();
    writeOrderResource(resourcesDir, expr);

    const inputs = collectResourceInputs({
      resourcesDir,
      modelsDir: join(dir, 'Models'),
      enumsDir: join(dir, 'Enums'),
      cwd: dir,
    });
    const { resources, enumNames, warnings } = buildResources(inputs, {}, false);
    return { block: generateResourcesDtsBlock(resources, enumNames), warnings };
  }

  it('emits LengthAwarePaginated<UserResource> for ->paginate(), importing @ferry/pagination', () => {
    const { block, warnings } = buildBlock('$this->users()->paginate()');
    expect(block).toContain('users: LengthAwarePaginated<UserResource>;');
    expect(block).toContain(`import type { LengthAwarePaginated } from '@ferry/pagination';`);
    expect(warnings).toHaveLength(0);
  });

  it('emits SimplePaginated<UserResource> for ->simplePaginate()', () => {
    const { block, warnings } = buildBlock('$this->users()->simplePaginate()');
    expect(block).toContain('users: SimplePaginated<UserResource>;');
    expect(block).toContain(`import type { SimplePaginated } from '@ferry/pagination';`);
    expect(warnings).toHaveLength(0);
  });

  it('emits CursorPaginated<UserResource> for ->cursorPaginate()', () => {
    const { block, warnings } = buildBlock('$this->users()->cursorPaginate()');
    expect(block).toContain('users: CursorPaginated<UserResource>;');
    expect(block).toContain(`import type { CursorPaginated } from '@ferry/pagination';`);
    expect(warnings).toHaveLength(0);
  });

  it('falls back to UserResource[] and warns when the argument could be a paginator but the kind cannot be resolved', () => {
    const { block, warnings } = buildBlock('$users');
    expect(block).toContain('users: UserResource[];');
    expect(block).not.toContain('@ferry/pagination');
    expect(warnings.some((w) => w.includes('OrderResource.users') && w.includes('paginator kind'))).toBe(true);
  });

  it('proves the envelope is a real, checked shape — not any — via a negative tsc assertion', () => {
    const { block } = buildBlock('$this->users()->paginate()');
    const ambient = assembleAmbientTypes({ blocks: [PAGINATION_BASE_DTS, block] });

    const consumer = dedent`
      import type { OrderResource } from '@ferry/resources';
      declare const order: OrderResource;

      // The envelope's real shape: data/links/meta, not a bare array.
      const total: number = order.users.meta.total;
      const first: string | null = order.users.links.first;
      const items: { id: string }[] = order.users.data;

      // @ts-expect-error the envelope has no array indexing/length — it is NOT UserResource[].
      // Were the field silently \`any\`, this directive would be unused and tsc would fail
      // (TS2578); the positive .meta/.links/.data assertions above are what catch a degrade
      // back to the old Item[] shape, since Item[] would compile the \`.length\` read too.
      const bogus: string = order.users.length;
    `;

    const { ok, output } = typecheck(ambient, consumer);
    expect(ok, `tsc reported errors:\n${output}`).toBe(true);
  });
});
