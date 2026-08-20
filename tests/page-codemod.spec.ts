import { describe, it, expect } from 'vitest';
import { transformRoutes, transformRoutesPost, pageTypeNameForId } from '../src/codemod/routes.js';
import type { RouteTable } from '../src/generators/routes.js';

const table: RouteTable = {
  'users.show': {
    name: 'users.show',
    uri: '/users/{user}',
    method: 'get',
    params: [{ name: 'user', optional: false }],
  },
};

const roots = ['/project/resources/js/Pages', '/project/resources/js/pages'];
const pre = (code: string, id: string) => transformRoutes(code, id, table, { roots });

describe('pageTypeNameForId', () => {
  it('resolves a page-component path under a Pages root to its props type name', () => {
    expect(pageTypeNameForId('/project/resources/js/Pages/Users/Show.tsx', roots)).toBe('UsersShowProps');
    expect(pageTypeNameForId('/project/resources/js/pages/Dashboard.jsx', roots)).toBe('DashboardProps');
  });

  it('returns null for a file outside every Pages root', () => {
    expect(pageTypeNameForId('/project/resources/js/Components/Card.tsx', roots)).toBeNull();
  });
});

describe('usePage generic injection (PRE pass)', () => {
  it('injects the page props type into a bare usePage() in a page component', () => {
    const out = pre(`const page = usePage();`, '/project/resources/js/Pages/Users/Show.tsx');
    expect(out?.code).toContain('usePage<UsersShowProps>()');
  });

  it('leaves an already-typed usePage<X>() untouched', () => {
    const out = pre(`const page = usePage<Custom>();`, '/project/resources/js/Pages/Users/Show.tsx');
    // No transform to make -> null (nothing else in the module changed).
    expect(out).toBeNull();
  });

  it('leaves usePage() alone in a non-Pages component (manual typing there)', () => {
    const out = pre(`const page = usePage();`, '/project/resources/js/Components/Nav.tsx');
    expect(out).toBeNull();
  });

  it('injects the generic alongside route rewriting in the same page module', () => {
    const code = `const page = usePage();\nconst url = route('users.show', { user: 1 });`;
    const out = pre(code, '/project/resources/js/Pages/Users/Show.tsx');
    expect(out?.code).toContain('usePage<UsersShowProps>()');
    expect(out?.code).toContain(`route('/users/{user}', { user: 1 }, 'get')`);
  });
});

describe('usePage generic injection is PRE-only', () => {
  // A compiled Svelte page module (types already stripped). The post pass must NOT inject
  // a generic — a type-argument injection cannot survive there.
  const compiled = [
    `import * as $ from 'svelte/internal/client';`,
    `function Page() {`,
    `  const page = usePage();`,
    `  const url = route('users.show', { user: 1 });`,
    `  return page;`,
    `}`,
  ].join('\n');

  it('does not inject a usePage generic in the post pass', () => {
    const out = transformRoutesPost(compiled, '/project/resources/js/Pages/Users/Show.svelte', table);
    // The route call is still rewritten, but usePage stays bare.
    expect(out?.code).toContain(`route('/users/{user}', { user: 1 }, 'get')`);
    expect(out?.code).toContain('usePage()');
    expect(out?.code).not.toContain('usePage<');
  });
});
