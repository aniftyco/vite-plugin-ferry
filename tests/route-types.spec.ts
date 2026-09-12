import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { generateRoutesDts, type RouteTable } from '../src/generators/routes.js';

const require = createRequire(import.meta.url);
const tscPath = require.resolve('typescript/bin/tsc');

const table: RouteTable = {
  'users.index': { name: 'users.index', uri: '/users', method: 'get', params: [] },
  'users.show': { name: 'users.show', uri: '/users/{user}', method: 'get', params: [{ name: 'user', optional: false }] },
  'admin.users.show': {
    name: 'admin.users.show',
    uri: '/admin/users/{user}',
    method: 'get',
    params: [{ name: 'user', optional: false }],
  },
  // A route whose only param is optional — must not force a params argument.
  archive: { name: 'archive', uri: '/archive/{year?}', method: 'get', params: [{ name: 'year', optional: true }] },
};

/** Type-check `consumer` against the generated ambient declarations, returning tsc output. */
function typecheck(consumer: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ferry-types-'));

  writeFileSync(join(dir, 'ferry.d.ts'), generateRoutesDts(table), 'utf8');
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
      files: ['ferry.d.ts', 'consumer.ts'],
    }),
    'utf8'
  );

  const result = spawnSync(process.execPath, [tscPath, '--project', join(dir, 'tsconfig.json')], {
    encoding: 'utf8',
  });

  return { ok: result.status === 0, output: (result.stdout ?? '') + (result.stderr ?? '') };
}

describe('generated route types (tsc --noEmit consumer check)', () => {
  it('accepts valid calls and rejects invalid ones in a single pass', () => {
    // Each `@ts-expect-error` both requires the next line to error AND fails tsc if it
    // does not, so one clean pass proves valid usages compile and invalid ones are caught.
    // Inertia's UrlMethodPair (@inertiajs/core) and the <Link href> type it feeds. The single
    // route() return must be assignable to a plain string, to UrlMethodPair, and to their union.
    const consumer = `
      type UrlMethodPair = { url: string; method: HttpMethod; component?: string | Record<string, string> };
      type LinkHref = string | UrlMethodPair;

      route('users.show', { user: 1 });
      route('users.index');
      route('users.index', { page: 2 });

      // & QueryBag must suppress excess-property errors on object literals (PLAN line ~125):
      route('users.show', { user: 1, tab: 'a' });

      // One return type, usable as a plain string...
      const s: string = route('users.show', { user: 1 });
      // ...as Inertia's { url, method } pair...
      const p: UrlMethodPair = route('users.show', { user: 1 });
      // ...and as the <Link href> union.
      const h: LinkHref = route('users.show', { user: 1 });

      // String methods resolve on the value directly (it is a real string).
      const starts: boolean = route('users.show', { user: 1 }).startsWith('/');

      // The url/method members are typed.
      const r: RouteResult = route('users.show', { user: 1 });
      const m: HttpMethod = r.method;
      const u: string = r.url;

      const active: boolean = route.is('users.show');
      route.is('users.show', { user: 1 });
      route.is('users.*');
      route.is('admin.users.*');

      // array form: names, wildcards, and a mix — matches if the current route is ANY of them.
      const anyOf: boolean = route.is(['users.show', 'users.index']);
      route.is(['users.*', 'admin.users.*']);
      route.is(['users.show', 'admin.users.*']);

      // an all-optional-param route accepts no params argument...
      route('archive');
      // ...and still accepts the optional param when given.
      route('archive', { year: 2020 });

      // @ts-expect-error missing required param
      route('users.show');
      // @ts-expect-error unknown route name
      route('nope.name');
      // @ts-expect-error bogus wildcard prefix
      route.is('bogus.*');
      // @ts-expect-error an unknown name in the array form is rejected
      route.is(['users.show', 'nope.name']);
      // @ts-expect-error negative control: method is not a number
      const wrong: number = route('users.show', { user: 1 }).method;
    `;

    const { ok, output } = typecheck(consumer);
    expect(ok, `tsc reported errors:\n${output}`).toBe(true);
  });
});
