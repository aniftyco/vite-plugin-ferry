import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { assembleAmbientTypes } from '../src/delivery/ambient-types.js';
import { ENUM_BASE_DTS } from '../src/delivery/enum-base.js';
import { collectEnums, generateEnumsDts, type EnumDefinition } from '../src/generators/enums.js';
import {
  pageKeyToTypeName,
  collectRenderInputs,
  collectSharedInput,
  buildPages,
  generatePagesDtsBlock,
  generateInertiaAugmentation,
  type PageEntry,
  type PropField,
  type RenderInput,
} from '../src/generators/pages.js';
import { generateResourcesDtsBlock, type ResourceEntry } from '../src/generators/resources.js';
import { generateRoutesDts, type RouteTable } from '../src/generators/routes.js';
import { dedent } from './utils.js';

const fixturesDir = join(import.meta.dirname, 'fixtures');
const repoRoot = join(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const tscPath = require.resolve('typescript/bin/tsc');

const knownEnums = new Set(Object.keys(collectEnums(join(fixturesDir, 'Enums'), fixturesDir)));
const knownResources = new Set(['UserResource', 'OrderResource', 'PostResource', 'CommentResource']);

function renderInputs(): RenderInput[] {
  return collectRenderInputs({
    controllersDir: join(fixturesDir, 'Controllers'),
    resourcesDir: join(fixturesDir, 'Resources'),
    modelsDir: join(fixturesDir, 'Models'),
    enumsDir: join(fixturesDir, 'Enums'),
    knownEnums,
  });
}

describe('pageKeyToTypeName', () => {
  it('maps a nested page key to an identifier-safe Props type name', () => {
    expect(pageKeyToTypeName('Users/Show')).toBe('UsersShowProps');
    expect(pageKeyToTypeName('Dashboard')).toBe('DashboardProps');
    expect(pageKeyToTypeName('Admin/Users/Edit')).toBe('AdminUsersEditProps');
  });

  it('pascal-cases lowercase and delimited segments', () => {
    expect(pageKeyToTypeName('users/show')).toBe('UsersShowProps');
    expect(pageKeyToTypeName('user-profile/edit_form')).toBe('UserProfileEditFormProps');
  });
});

describe('collectRenderInputs (Inertia::render analysis)', () => {
  it('extracts the page key and infers prop types via the resource machinery', () => {
    const show = renderInputs().find((i) => i.key === 'Users/Show');

    expect(show).toBeTruthy();
    // resource prop -> a @ferry/resources reference (single and collection)
    expect(show!.fields.user.type).toBe('UserResource');
    expect(show!.fields.orders.type).toBe('OrderResource[]');
    // enum prop -> a @ferry/enums reference
    expect(show!.fields.status.type).toBe('OrderStatus');
    // scalar prop -> the leaf type
    expect(show!.fields.title.type).toBe('string');
  });

  it('recurses into nested controller directories', () => {
    const keys = renderInputs().map((i) => i.key);
    // Admin/DashboardController is one directory deep.
    expect(keys).toContain('Dashboard');
  });

  it('infers ternary props: branch-union with null-folding, and undecidable fall-through', () => {
    const report = renderInputs().find((i) => i.key === 'Reports/Show')!;

    // `$cond ? OrderStatus::PENDING : null` -> the enum type unioned with null.
    expect(report.fields.status.type).toBe('OrderStatus | null');
    expect(report.fields.status.undecidable).toBeUndefined();

    // `$a ? 'x' : 'y'` -> both string branches collapse to one `string`.
    expect(report.fields.label.type).toBe('string');

    // `$cond ? $service->compute() : null` -> an undecidable branch degrades the whole prop.
    expect(report.fields.summary.undecidable).toBe(true);
    expect(report.fields.summary.type).toBe('any');
  });
});

describe('buildPages', () => {
  it('unions the shapes of a page rendered from multiple actions', () => {
    const { pages } = buildPages(renderInputs(), false);
    const dashboard = pages.find((p) => p.typeName === 'DashboardProps')!;

    // Two actions render 'Dashboard' with different `total` types -> a union of shapes.
    expect(dashboard.type).toContain('|');
    expect(dashboard.type).toContain('{ user: UserResource; total: any }');
    expect(dashboard.type).toContain('{ user: UserResource; total: number }');
  });

  it('degrades an undecidable prop to `any` (strict:false) with a warning naming page + prop', () => {
    const { warnings } = buildPages(renderInputs(), false);
    const total = warnings.find((w) => w.includes('Dashboard.total'));

    expect(total).toBeTruthy();
    expect(total).toContain('@ferry total');
  });

  it('degrades an undecidable prop to `unknown` under strict:true', () => {
    const input: RenderInput = {
      key: 'Widgets',
      fields: { blob: { type: 'any', optional: false, undecidable: true } },
    };
    const { pages } = buildPages([input], true);

    expect(pages[0].type).toBe('{ blob: unknown }');
  });

  it('applies a @ferry <prop> override on the action verbatim, clearing degradation', () => {
    // DashboardController::stats pins `total` to `number` via `@ferry total number`.
    const statsShape = renderInputs().filter((i) => i.key === 'Dashboard');
    const pinned = statsShape.find((i) => i.fields.total.type === 'number');

    expect(pinned).toBeTruthy();
    expect(pinned!.fields.total.undecidable).toBe(false);
  });
});

describe('collectSharedInput (HandleInertiaRequests::share)', () => {
  it('reads the shared-data shape through array_merge(parent::share(), [...])', () => {
    const shared = collectSharedInput({
      middlewareDir: join(fixturesDir, 'Middleware'),
      resourcesDir: join(fixturesDir, 'Resources'),
      modelsDir: join(fixturesDir, 'Models'),
      enumsDir: join(fixturesDir, 'Enums'),
      knownEnums,
    });

    expect(shared.fields.auth.type).toBe('{ user: UserResource }');
    expect(shared.fields.appName.type).toBe('string');
  });

  it('degrades to an empty shape when the middleware is absent', () => {
    const shared = collectSharedInput({
      middlewareDir: join(fixturesDir, 'DoesNotExist'),
      resourcesDir: join(fixturesDir, 'Resources'),
      modelsDir: join(fixturesDir, 'Models'),
      enumsDir: join(fixturesDir, 'Enums'),
      knownEnums,
    });

    expect(shared.fields).toEqual({});
  });

  it('applies @ferry pins on share(): declares a new conditionally-shared prop and clears an unresolvable one', () => {
    const shared = collectSharedInput({
      middlewareDir: join(fixturesDir, 'MiddlewarePinned'),
      resourcesDir: join(fixturesDir, 'Resources'),
      modelsDir: join(fixturesDir, 'Models'),
      enumsDir: join(fixturesDir, 'Enums'),
      knownEnums,
    });

    // A statically-resolvable prop is untouched.
    expect(shared.fields.auth.type).toBe('{ user: UserResource }');

    // `settings` is an unresolvable method call; without the pin it would degrade. The
    // pin types it verbatim and clears the "could not be resolved statically" signal (AC4).
    expect(shared.fields.settings.type).toBe('Record<string, string>');
    expect(shared.fields.settings.undecidable).toBe(false);

    // `flash` is never in the returned array — the pin declares it outright (AC2).
    expect(shared.fields.flash.type).toBe('{ message: string }');
    expect(shared.fields.flash.undecidable).toBe(false);

    // The observable outcome of AC4: the degradation warning is actually suppressed. Run the
    // pinned fields through the same finalize path buildPages uses; no "could not be resolved
    // statically" warning is emitted for the pinned `settings` prop.
    const { warnings } = buildPages([{ key: 'share()', fields: shared.fields }], false);
    expect(warnings.some((w) => w.includes('settings') && w.includes('could not be resolved statically'))).toBe(
      false
    );
  });

  it('merges parent::share() fields, with the child taking precedence on collisions (AC1)', () => {
    const shared = collectSharedInput({
      middlewareDir: join(fixturesDir, 'MiddlewareWithParent'),
      resourcesDir: join(fixturesDir, 'Resources'),
      modelsDir: join(fixturesDir, 'Models'),
      enumsDir: join(fixturesDir, 'Enums'),
      knownEnums,
    });

    // The child's own inline prop.
    expect(shared.fields.auth.type).toBe('{ user: UserResource }');

    // A prop only the parent's share() declares still appears in the shared shape.
    expect(shared.fields.appName.type).toBe('string');

    // Both define `version`; the child's inline value wins over the parent's unresolvable one.
    expect(shared.fields.version.type).toBe('number');
    expect(shared.fields.version.undecidable).toBeUndefined();
  });
});

describe('generateInertiaAugmentation', () => {
  const shared: Record<string, PropField> = {
    auth: { type: '{ user: UserResource }', optional: false },
    appName: { type: 'string', optional: false },
  };
  const augmentation = generateInertiaAugmentation(shared, knownResources, knownEnums);

  it('emits a module-style augmentation of @inertiajs/core filling sharedPageProps and errorValueType', () => {
    expect(augmentation).toContain(`import '@inertiajs/core';`);
    expect(augmentation).toContain(`import type { UserResource } from '@ferry/resources';`);
    expect(augmentation).toContain(`declare module '@inertiajs/core' {`);
    expect(augmentation).toContain(`sharedPageProps: { auth: { user: UserResource }; appName: string };`);
    expect(augmentation).toContain(`errorValueType: string;`);
  });

  it('does NOT emit slots that are not inferable from the backend', () => {
    expect(augmentation).not.toContain('flashDataType');
    expect(augmentation).not.toContain('layoutProps');
    expect(augmentation).not.toContain('namedLayoutProps');
  });
});

describe('generatePagesDtsBlock', () => {
  it('renders one export type per page, importing referenced resources and enums', () => {
    const pages: PageEntry[] = [
      { typeName: 'UsersShowProps', type: '{ user: UserResource; status: OrderStatus }' },
      { typeName: 'DashboardProps', type: '{ user: UserResource }' },
    ];

    const block = generatePagesDtsBlock(pages, knownResources, knownEnums);

    expect(block).toBe(
      dedent`
        declare module '@ferry/pages' {
          import type { UserResource } from '@ferry/resources';
          import { OrderStatus } from '@ferry/enums';

          export type UsersShowProps = { user: UserResource; status: OrderStatus };
          export type DashboardProps = { user: UserResource };
        }
      `.trimEnd()
    );
  });

  it('emits an empty declare module block when there are no pages', () => {
    expect(generatePagesDtsBlock([], knownResources, knownEnums)).toBe(`declare module '@ferry/pages' {}`);
  });
});

describe('page-key → type-name collisions', () => {
  // Two distinct render keys that normalize to the same props type name.
  const inputs: RenderInput[] = [
    { key: 'Users/Show', fields: { id: { type: 'number', optional: false } } },
    { key: 'users/show', fields: { slug: { type: 'string', optional: false } } },
  ];

  it('merges colliding keys into one export type (a union of shapes), never a duplicate declaration', () => {
    const { pages } = buildPages(inputs, false);
    expect(pages).toHaveLength(1);
    expect(pages[0].typeName).toBe('UsersShowProps');
    expect(pages[0].type).toBe('{ id: number } | { slug: string }');

    const block = generatePagesDtsBlock(pages, knownResources, knownEnums);
    const declarations = block.match(/export type UsersShowProps\b/g) ?? [];
    expect(declarations).toHaveLength(1);
  });

  it('produces a compilable block — no TS2300 duplicate-identifier from the collision', () => {
    const { pages } = buildPages(inputs, false);
    const ambient = assembleAmbientTypes({
      blocks: [ENUM_BASE_DTS, generatePagesDtsBlock(pages, knownResources, knownEnums)],
    });

    const consumer = dedent`
      import type { UsersShowProps } from '@ferry/pages';

      const a = { id: 1 } as UsersShowProps;
      const b = { slug: 'x' } as UsersShowProps;
    `;

    const { ok, output } = typecheck(ambient, '', consumer);
    expect(ok, `tsc reported errors:\n${output}`).toBe(true);
    expect(output).not.toContain('TS2300');
  });
});

// ---------------------------------------------------------------------------
// tsc --noEmit consumer check
// ---------------------------------------------------------------------------

/**
 * Type-check a consumer against the assembled ambient script file plus the separate
 * `@inertiajs/core` augmentation module file. The temp project lives inside the repo so
 * upward node_modules resolution finds the real `@inertiajs/core`, making the check real.
 */
function typecheck(
  ambient: string,
  augmentation: string,
  consumer: string
): { ok: boolean; output: string; ambient: string } {
  const dir = mkdtempSync(join(repoRoot, 'ferry-pages-'));
  try {
    writeFileSync(join(dir, 'index.d.ts'), ambient, 'utf8');
    writeFileSync(join(dir, 'inertia.d.ts'), augmentation, 'utf8');
    writeFileSync(join(dir, 'consumer.ts'), consumer, 'utf8');
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'esnext',
          moduleResolution: 'bundler',
          module: 'esnext',
          skipLibCheck: true,
          noEmit: true,
          types: [],
        },
        files: ['index.d.ts', 'inertia.d.ts', 'consumer.ts'],
      }),
      'utf8'
    );

    const result = spawnSync(process.execPath, [tscPath, '--project', join(dir, 'tsconfig.json')], {
      encoding: 'utf8',
    });

    return { ok: result.status === 0, output: (result.stdout ?? '') + (result.stderr ?? ''), ambient };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('generated page types (tsc --noEmit consumer check)', () => {
  const orderStatus: EnumDefinition = {
    name: 'OrderStatus',
    backing: 'string',
    cases: [
      { key: 'PENDING', value: 'pending', label: 'Pending' },
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
  };

  const pages: PageEntry[] = [
    { typeName: 'UsersShowProps', type: '{ id: number; status: OrderStatus; user?: UserResource }' },
  ];

  const shared: Record<string, PropField> = {
    auth: { type: '{ user: UserResource }', optional: false },
    appName: { type: 'string', optional: false },
  };

  const augmentation = generateInertiaAugmentation(shared, knownResources, knownEnums);

  const ambient = assembleAmbientTypes({
    blocks: [
      ENUM_BASE_DTS,
      generateEnumsDts({ OrderStatus: orderStatus }),
      generateRoutesDts(routeTable),
      generateResourcesDtsBlock(resources, new Set(['OrderStatus'])),
      generatePagesDtsBlock(pages, knownResources, new Set(['OrderStatus'])),
    ],
    moduleFiles: [{ fileName: 'inertia.d.ts', content: augmentation }],
  });

  it('keeps the ambient index.d.ts a script (zero top-level import/export)', () => {
    const topLevel = ambient.split('\n').filter((line) => /^(import|export)\b/.test(line));
    expect(topLevel).toEqual([]);
  });

  it('references the separate augmentation module file via a triple-slash directive', () => {
    expect(ambient).toContain('/// <reference path="./inertia.d.ts" />');
  });

  it('type-checks shared props via the augmentation, usePage<T>, routes and enums together', () => {
    const consumer = dedent`
      import '@inertiajs/core';
      import type { SharedPageProps, ErrorValue } from '@inertiajs/core';
      import type { UsersShowProps } from '@ferry/pages';
      import { OrderStatus } from '@ferry/enums';

      // The augmentation flows into Inertia's own SharedPageProps.
      const shared = null as unknown as SharedPageProps;
      const uname: string = shared.auth.user.name;
      const appName: string = shared.appName;

      // errorValueType is filled with Laravel's error value shape.
      const err: ErrorValue = 'Field is required';

      // usePage<UsersShowProps>() resolves the per-page props and merges shared props.
      declare function usePage<T>(): { props: SharedPageProps & T };
      const page = usePage<UsersShowProps>();
      const id: number = page.props.id;
      const status: OrderStatus = page.props.status;
      const owner = page.props.auth.user;

      // routes' declarations still coexist in the same ambient file.
      const url: string = route('users.show', { user: 1 }).url;

      // @ts-expect-error page id is a number, not a string
      const bad: string = page.props.id;
    `;

    const { ok, output } = typecheck(ambient, augmentation, consumer);
    expect(ok, `tsc reported errors:\n${output}`).toBe(true);
  });
});
