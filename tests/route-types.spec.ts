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
    const consumer = `
      route('users.show', { user: 1 });
      route('users.index');
      route('users.index', { page: 2 });

      // & QueryBag must suppress excess-property errors on object literals (PLAN line ~125):
      route('users.show', { user: 1, tab: 'a' });

      const r = route('users.show', { user: 1 });
      const m: HttpMethod = r.method;
      const u: string = r.url;
      const str: string = route<string>('users.show', { user: 1 });

      route.isCurrent('users.show');
      route.isCurrent('users.*');
      route.isCurrent('admin.users.*');

      // @ts-expect-error missing required param
      route('users.show');
      // @ts-expect-error unknown route name
      route('nope.name');
      // @ts-expect-error bogus wildcard prefix
      route.isCurrent('bogus.*');
    `;

    const { ok, output } = typecheck(consumer);
    expect(ok, `tsc reported errors:\n${output}`).toBe(true);
  });
});
