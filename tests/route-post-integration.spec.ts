import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { build, type Plugin, type RollupOutput } from 'vite';
import { createDelivery } from '../src/delivery/index.js';
import { ROUTE_RUNTIME } from '../src/delivery/route-runtime.js';
import { transformRoutesPost } from '../src/codemod/routes.js';
import type { RouteTable } from '../src/generators/routes.js';

const table: RouteTable = {
  'users.show': { name: 'users.show', uri: '/users/{user}', method: 'get', params: [{ name: 'user', optional: false }] },
};

/**
 * Probe the exact concern the coordinator flagged: an `import { route } from '@ferry/route'`
 * injected by a transform at `enforce: 'post'` must still be resolved (and its runtime
 * bundled) by the pre-pass resolveId/load. A real `vite build` proves it — if the injected
 * import did not resolve, rollup would throw "Could not resolve '@ferry/route'".
 */
describe('post-pass injected import resolves through a real vite build', () => {
  it('rewrites a route() call in a compiled .svelte module and bundles the resolver', { timeout: 30000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ferry-vite-'));

    // A plain-JS module standing in for svelte.compile() output; the pre transform below
    // hands it to the pipeline as JS, the way plugin-svelte would.
    writeFileSync(join(dir, 'Comp.svelte'), `export function render() { return String(route('users.show', { user: 7 })); }\n`, 'utf8');
    writeFileSync(join(dir, 'main.js'), `import { render } from './Comp.svelte';\nexport const out = render();\n`, 'utf8');

    const delivery = createDelivery(dir);
    delivery.virtual.register('@ferry/route', ROUTE_RUNTIME);

    // Stand in for plugin-svelte: mark the .svelte module as already-compiled JS.
    const svelteAsJs: Plugin = {
      name: 'svelte-as-js',
      enforce: 'pre',
      transform(code, id) {
        return id.split('?')[0].endsWith('.svelte') ? { code, map: null } : null;
      },
    };

    // Ferry's real delivery + real post codemod — only the route table and the .svelte
    // compile are faked; the resolution path and the transform are the shipping code.
    const ferryMain: Plugin = {
      name: 'ferry-main',
      enforce: 'pre',
      resolveId: (id) => delivery.resolveId(id),
      load: (id) => delivery.load(id),
    };
    const ferryPost: Plugin = {
      name: 'ferry-post',
      enforce: 'post',
      transform: (code, id) => transformRoutesPost(code, id, table),
    };

    const result = (await build({
      root: dir,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry: join(dir, 'main.js'), formats: ['es'], fileName: 'bundle' },
      },
      plugins: [svelteAsJs, ferryMain, ferryPost],
    })) as RollupOutput | RollupOutput[];

    const output = (Array.isArray(result) ? result[0] : result).output;
    const code = output.map((chunk) => (chunk.type === 'chunk' ? chunk.code : '')).join('\n');

    // The route name was rewritten to its URI pattern...
    expect(code).toContain('/users/{user}');
    // ...and the resolver runtime was bundled (proving the injected import resolved).
    expect(code).toContain('URLSearchParams');
  });
});
