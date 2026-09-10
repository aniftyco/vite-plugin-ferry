import { describe, it, expect } from 'vitest';
import { transformRoutes, transformRoutesPost } from '../src/codemod/routes.js';
import type { RouteTable } from '../src/generators/routes.js';

const table: RouteTable = {
  'users.show': {
    name: 'users.show',
    uri: '/users/{user}',
    method: 'get',
    params: [{ name: 'user', optional: false }],
  },
};

const pageId = '/project/resources/js/Pages/Users/Show.tsx';

// The codemod no longer injects a `usePage<PageProps>()` generic. Consumers import the props
// type from `@ferry/pages` and pass it themselves; `@ferry/pages` still generates those types.
describe('usePage() is never auto-injected', () => {
  it('leaves a bare usePage() untouched in a page-component file', () => {
    // Nothing else in the module changes, so there is no transform to make.
    expect(transformRoutes(`const page = usePage();`, pageId, table)).toBeNull();
  });

  it('leaves usePage() bare while still rewriting route() in the same page module', () => {
    const code = `const page = usePage();\nconst url = route('users.show', { user: 1 });`;
    const out = transformRoutes(code, pageId, table);

    expect(out?.code).toContain('usePage()');
    expect(out?.code).not.toContain('usePage<');
    expect(out?.code).toContain(`route('/users/{user}', { user: 1 }, 'get')`);
  });

  it('leaves usePage() bare in a compiled page module (post pass)', () => {
    const compiled = [
      `import * as $ from 'svelte/internal/client';`,
      `function Page() {`,
      `  const page = usePage();`,
      `  const url = route('users.show', { user: 1 });`,
      `  return page;`,
      `}`,
    ].join('\n');

    const out = transformRoutesPost(compiled, '/project/resources/js/Pages/Users/Show.svelte', table);
    expect(out?.code).toContain(`route('/users/{user}', { user: 1 }, 'get')`);
    expect(out?.code).toContain('usePage()');
    expect(out?.code).not.toContain('usePage<');
  });
});
