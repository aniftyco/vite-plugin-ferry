import { describe, it, expect, vi } from 'vitest';
import {
  transformRoutes,
  transformRoutesPost,
  shouldTransformPre,
  shouldTransformPost,
  deriveLang,
  RouteCodemodError,
} from '../src/codemod/routes.js';
import type { RouteTable } from '../src/generators/routes.js';

const table: RouteTable = {
  'users.index': { name: 'users.index', uri: '/users', method: 'get', params: [] },
  'users.show': { name: 'users.show', uri: '/users/{user}', method: 'get', params: [{ name: 'user', optional: false }] },
  'users.destroy': { name: 'users.destroy', uri: '/users/{user}', method: 'delete', params: [{ name: 'user', optional: false }] },
  'admin.users.show': {
    name: 'admin.users.show',
    uri: '/admin/users/{user}',
    method: 'get',
    params: [{ name: 'user', optional: false }],
  },
};

const run = (code: string, id = '/project/src/app.tsx') => transformRoutes(code, id, table);

describe('shouldTransformPre', () => {
  it('accepts js/ts/jsx/tsx modules', () => {
    for (const id of ['/a/b.ts', '/a/b.tsx', '/a/b.js', '/a/b.jsx', '/a/b.mts']) {
      expect(shouldTransformPre(id)).toBe(true);
    }
  });

  it('rejects node_modules, declaration files, and non-source', () => {
    expect(shouldTransformPre('/a/node_modules/x/b.ts')).toBe(false);
    expect(shouldTransformPre('/a/b.d.ts')).toBe(false);
    expect(shouldTransformPre('/a/b.css')).toBe(false);
  });

  it('ignores a trailing query string', () => {
    expect(shouldTransformPre('/a/b.tsx?v=1')).toBe(true);
  });

  it('excludes Vue and Svelte compiled requests (owned by the post pass)', () => {
    expect(shouldTransformPre('/a/Foo.vue')).toBe(false);
    expect(shouldTransformPre('/a/Foo.vue?vue&type=script&setup=true&lang.ts')).toBe(false);
    expect(shouldTransformPre('/a/Foo.svelte')).toBe(false);
    expect(shouldTransformPre('/a/Foo.svelte?xyz')).toBe(false);
  });
});

describe('shouldTransformPost', () => {
  it('accepts svelte modules, the vue main module, and the vue script sub-request', () => {
    expect(shouldTransformPost('/a/Foo.svelte')).toBe(true);
    expect(shouldTransformPost('/a/Foo.vue')).toBe(true);
    expect(shouldTransformPost('/a/Foo.vue?vue&type=script&setup=true&lang.ts')).toBe(true);
  });

  it('ignores vue template and style sub-requests', () => {
    expect(shouldTransformPost('/a/Foo.vue?vue&type=template&lang.js')).toBe(false);
    expect(shouldTransformPost('/a/Foo.vue?vue&type=style&index=0&lang.css')).toBe(false);
  });

  it('ignores plain source and node_modules', () => {
    expect(shouldTransformPost('/a/b.tsx')).toBe(false);
    expect(shouldTransformPost('/a/node_modules/x/Foo.vue')).toBe(false);
  });
});

describe('pre/post id ownership is mutually exclusive', () => {
  const ids = [
    '/a/b.tsx',
    '/a/b.ts',
    '/a/Foo.vue',
    '/a/Foo.vue?vue&type=script&setup=true&lang.ts',
    '/a/Foo.vue?vue&type=template&lang.js',
    '/a/Foo.svelte',
  ];

  it('never lets both passes own the same id', () => {
    for (const id of ids) {
      expect(shouldTransformPre(id) && shouldTransformPost(id)).toBe(false);
    }
  });

  it('routes a vue script sub-request to post only, and a tsx to pre only', () => {
    const vue = '/a/Foo.vue?vue&type=script&setup=true&lang.ts';
    expect(shouldTransformPre(vue)).toBe(false);
    expect(shouldTransformPost(vue)).toBe(true);

    expect(shouldTransformPre('/a/App.tsx')).toBe(true);
    expect(shouldTransformPost('/a/App.tsx')).toBe(false);
  });
});

describe('deriveLang', () => {
  it('reads the &lang.<ext> query token when present', () => {
    expect(deriveLang('/a/Foo.vue?vue&type=script&setup=true&lang.ts')).toBe('ts');
    expect(deriveLang('/a/Foo.vue?vue&type=script&lang.tsx')).toBe('tsx');
  });

  it('falls back to the file extension', () => {
    expect(deriveLang('/a/App.tsx')).toBe('tsx');
    expect(deriveLang('/a/App.ts')).toBe('ts');
    expect(deriveLang('/a/App.jsx')).toBe('jsx');
    expect(deriveLang('/a/App.js')).toBe('js');
    expect(deriveLang('/a/Foo.svelte')).toBe('js');
  });
});

describe('transformRoutes', () => {
  it('bails when the source never mentions route', () => {
    expect(run(`const x = 1;`)).toBeNull();
  });

  it('rewrites a route name to its URI pattern and injects the method', () => {
    const out = run(`route('users.show', { user: 1 });`);
    expect(out?.code).toContain(`route('/users/{user}', { user: 1 }, 'get')`);
  });

  it('injects an undefined params slot for a no-argument route call', () => {
    const out = run(`route('users.index');`);
    expect(out?.code).toContain(`route('/users', undefined, 'get')`);
  });

  it('injects delete method for a destructive route', () => {
    const out = run(`route('users.destroy', { user: 1 });`);
    expect(out?.code).toContain(`route('/users/{user}', { user: 1 }, 'delete')`);
  });

  it('appends .url for a route<string> call', () => {
    const out = run(`const u = route<string>('users.show', { user: 1 });`);
    expect(out?.code).toContain(`route<string>('/users/{user}', { user: 1 }, 'get').url`);
  });

  it('throws a build error for a non-literal route name', () => {
    expect(() => run(`route(name);`)).toThrow(RouteCodemodError);
  });

  it('throws a build error for a non-literal isCurrent pattern', () => {
    expect(() => run(`route.isCurrent(name);`)).toThrow(RouteCodemodError);
  });

  it('rewrites an exact isCurrent name to its pattern', () => {
    const out = run(`route.isCurrent('users.show');`);
    expect(out?.code).toContain(`route.isCurrent('/users/{user}')`);
  });

  it('expands a wildcard isCurrent to the matching patterns', () => {
    // Patterns are deduped in sorted-route-name order; users.destroy and users.show
    // share '/users/{user}', so it appears once, before users.index's '/users'.
    const out = run(`route.isCurrent('users.*');`);
    expect(out?.code).toContain(`route.isCurrent(['/users/{user}', '/users'])`);
  });

  it('warns and emits false for a zero-match wildcard', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = run(`const active = route.isCurrent('bogus.*');`);
    expect(out?.code).toContain(`const active = false;`);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns when a wildcard expands to an unusually large set of patterns', () => {
    // Over BROAD_WILDCARD_THRESHOLD (25) distinct patterns under one prefix: the wildcard
    // still expands (shipping every pattern) but warns that many patterns reach the client.
    const bigTable: RouteTable = {};
    for (let i = 0; i < 30; i++) {
      const name = `reports.r${i}`;
      bigTable[name] = { name, uri: `/reports/${i}`, method: 'get', params: [] };
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = transformRoutes(`route.isCurrent('reports.*');`, '/project/src/app.tsx', bigTable);
    expect(warn).toHaveBeenCalled();
    // The expansion still ships every matched pattern (this is a warning, not a bail).
    expect(out?.code).toContain(`'/reports/0'`);
    expect(out?.code).toContain(`'/reports/29'`);
    warn.mockRestore();
  });

  it('injects the resolver import exactly once', () => {
    const out = run(`route('users.show', { user: 1 }); route('users.index');`);
    const occurrences = out?.code.match(/@ferry\/route/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(out?.code.startsWith(`import { route } from '@ferry/route';`)).toBe(true);
  });

  it('does not inject a second import when one already exists', () => {
    const out = run(`import { route } from '@ferry/route';\nroute('users.index');`);
    const occurrences = out?.code.match(/@ferry\/route/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('returns a source map alongside the code', () => {
    const out = run(`route('users.index');`);
    expect(out?.map).toBeTruthy();
    expect(out?.map.mappings).toBeTypeOf('string');
  });
});

describe('no-leak guarantee (only referenced patterns ship)', () => {
  // A table whose routes have DISTINCT URI patterns so an unreferenced route's pattern is
  // identifiable by its absence — proving the full table never ships, only what is referenced.
  const distinctTable: RouteTable = {
    'users.index': { name: 'users.index', uri: '/users', method: 'get', params: [] },
    'users.show': {
      name: 'users.show',
      uri: '/users/{user}',
      method: 'get',
      params: [{ name: 'user', optional: false }],
    },
    'posts.destroy': {
      name: 'posts.destroy',
      uri: '/posts/{post}',
      method: 'delete',
      params: [{ name: 'post', optional: false }],
    },
  };

  it('inlines only the referenced route pattern, leaking no unreferenced patterns', () => {
    const out = transformRoutes(`route('users.show', { user: 1 });`, '/project/src/app.tsx', distinctTable);

    // The referenced route's pattern arrives inline...
    expect(out?.code).toContain(`/users/{user}`);
    // ...while every unreferenced route's pattern is absent from the module.
    expect(out?.code).not.toContain(`/posts/{post}`);
    expect(out?.code).not.toContain(`/users'`);
  });
});

describe('transformRoutesPost (compiled Vue/Svelte modules)', () => {
  // Representative svelte.compile() output: a plain JS module (TS already stripped) with a
  // bare route() call surviving from the component's <script>.
  const compiledSvelte = [
    `import * as $ from 'svelte/internal/client';`,
    `function Comp($$anchor) {`,
    `  const href = route('users.show', { user: 7 });`,
    `  const active = route.isCurrent('users.*');`,
    `  return href;`,
    `}`,
    `export default Comp;`,
  ].join('\n');

  // Representative plugin-vue compileScript() build sub-request output: plain JS.
  const compiledVueScript = [
    `import { defineComponent as _defineComponent } from 'vue';`,
    `export default _defineComponent({`,
    `  setup(__props) {`,
    `    const url = route('users.show', { user: 7 });`,
    `    return () => {};`,
    `  },`,
    `});`,
  ].join('\n');

  it('rewrites a bare route() call in a compiled svelte module and injects the import once', () => {
    const out = transformRoutesPost(compiledSvelte, '/a/Comp.svelte', table);
    expect(out?.code).toContain(`route('/users/{user}', { user: 7 }, 'get')`);
    const occurrences = out?.code.match(/@ferry\/route/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(out?.code.startsWith(`import { route } from '@ferry/route';`)).toBe(true);
  });

  it('expands an isCurrent wildcard in a compiled svelte module', () => {
    const out = transformRoutesPost(compiledSvelte, '/a/Comp.svelte', table);
    expect(out?.code).toContain(`route.isCurrent(['/users/{user}', '/users'])`);
  });

  it('does NOT append .url in the post pass (no <string> type argument survives)', () => {
    const out = transformRoutesPost(compiledSvelte, '/a/Comp.svelte', table);
    expect(out?.code).not.toContain('.url');
  });

  it('rewrites a bare route() call in a compiled vue script sub-request', () => {
    const id = '/a/Comp.vue?vue&type=script&setup=true&lang.ts';
    const out = transformRoutesPost(compiledVueScript, id, table);
    expect(out?.code).toContain(`route('/users/{user}', { user: 7 }, 'get')`);
    expect(out?.code.startsWith(`import { route } from '@ferry/route';`)).toBe(true);
  });

  it('ignores a Vue template sub-request (bindings compile to _ctx.route)', () => {
    const template = `const _hoisted = _ctx.route('users.show', { user: 7 });`;
    const id = '/a/Comp.vue?vue&type=template&lang.js';
    expect(transformRoutesPost(template, id, table)).toBeNull();
  });

  it('does not run over a plain .tsx module in the post pass', () => {
    expect(transformRoutesPost(`route('users.index');`, '/a/App.tsx', table)).toBeNull();
  });

  it('still errors on a non-literal route name in compiled output', () => {
    const compiled = `function C(){ return route(dynamicName); }`;
    expect(() => transformRoutesPost(compiled, '/a/Comp.svelte', table)).toThrow(RouteCodemodError);
  });
});
