import { join } from 'node:path';
import type { Plugin } from 'vite';
import { transformRoutes, transformRoutesPost } from './codemod/routes.js';
import { createDelivery } from './delivery/index.js';
import { registerEnums } from './generators/enums.js';
import { registerPages } from './generators/pages.js';
import { registerResources } from './generators/resources.js';
import { registerRoutes, type RouteTable } from './generators/routes.js';
import { setupEnumWatcher } from './watchers/enums.js';
import { setupPageWatcher } from './watchers/pages.js';
import { setupResourceWatcher } from './watchers/resources.js';
import { setupRouteWatcher } from './watchers/routes.js';

export type ResourceTypesPluginOptions = {
  cwd?: string;
  /**
   * Fallback type for resource fields ferry can't resolve statically. `false` (default)
   * → `any` (never breaks a typecheck); `true` → `unknown` (forces the consumer to narrow).
   */
  strict?: boolean;
  /**
   * Inertia page-component root(s), relative to `cwd`, used to resolve a page key from a
   * file path for `usePage()` generic injection. Defaults to the common Inertia layouts
   * `resources/js/Pages` and `resources/js/pages`.
   */
  pagesDir?: string | string[];
};

/**
 * Vite plugin for generating TypeScript from Laravel PHP files.
 *
 * Delivery per type:
 * - @ferry/enums - PHP enums as classes on the base `Enum`, served as a virtual
 *   module (runtime) plus a `declare module` block in the ambient d.ts (types); nothing on disk.
 * - @ferry/resources - Laravel JsonResource types from static `toArray()` analysis plus a
 *   `tinker` metadata dump, served as a type-only virtual module plus a `declare module`
 *   block in the ambient d.ts; nothing on disk.
 */
export default function ferry(options: ResourceTypesPluginOptions = {}): Plugin[] {
  const namespace = '@ferry';
  const name = 'vite-plugin-ferry';

  // Apply defaults
  const cwd = options.cwd ?? process.cwd();
  const strict = options.strict ?? false;

  // Directory paths
  const enumsDir = join(cwd, 'app/Enums');
  const resourcesDir = join(cwd, 'app/Http/Resources');
  const modelsDir = join(cwd, 'app/Models');
  const routesDir = join(cwd, 'routes');
  const controllersDir = join(cwd, 'app/Http/Controllers');
  const middlewareDir = join(cwd, 'app/Http/Middleware');

  // Inertia page-component roots for usePage() generic injection.
  const pagesDirOption = options.pagesDir ?? ['resources/js/Pages', 'resources/js/pages'];
  const pagesRoots = (Array.isArray(pagesDirOption) ? pagesDirOption : [pagesDirOption]).map((dir) => join(cwd, dir));

  // Delivery layer: virtual modules (runtime) + ambient .d.ts (types).
  const delivery = createDelivery(cwd);

  // The current route table, fed to the codemod. Rebuilt on every generation pass
  // and on route-file changes in dev.
  let routeTable: RouteTable = {};

  /**
   * Generate all packages.
   */
  function generateAll() {
    // Register @ferry/enums runtime (virtual module) and its d.ts block.
    registerEnums({ enumsDir, cwd, delivery });

    // Register @ferry/route runtime + declarations, and keep the table for the codemod.
    routeTable = registerRoutes({ cwd, delivery });

    // Register @ferry/resources runtime (type-only virtual module) and its d.ts block.
    registerResources({ resourcesDir, modelsDir, cwd, delivery, strict });

    // Register @ferry/pages (per-page prop types) and the @inertiajs/core augmentation.
    registerPages({ controllersDir, middlewareDir, resourcesDir, modelsDir, cwd, delivery, strict });

    // Write the ambient declarations file from the registered d.ts blocks.
    delivery.writeTypes();
  }

  // The main plugin runs at `enforce: 'pre'`: it serves the virtual modules, generates
  // types, and runs the route codemod over real source files (React/JSX + plain TS/JS).
  const main: Plugin = {
    name,
    enforce: 'pre',

    // Serve ferry virtual modules (runtime) from the delivery registry.
    resolveId(id) {
      return delivery.resolveId(id);
    },

    load(id) {
      return delivery.load(id);
    },

    // Rewrite literal route() / route.isCurrent() calls: name -> URI pattern, inject
    // the resolver import, and keep the full route table out of the browser bundle.
    transform(code, id) {
      return transformRoutes(code, id, routeTable, { roots: pagesRoots });
    },

    // Generate once per startup, during config resolution, so the ambient d.ts and
    // virtual-module registrations exist before any consumer needs them. `config` fires
    // on both `vite dev` and `vite build`, and dev-time freshness is the watchers' job,
    // so this is the sole generation pass — no duplicate PHP subprocess spawns.
    config() {
      try {
        generateAll();
      } catch (e) {
        console.error(`[${name}] Error generating types during config():`, e);
      }

      return {
        optimizeDeps: {
          exclude: [`${namespace}/enums`, `${namespace}/resources`, `${namespace}/route`, `${namespace}/pages`],
        },
      };
    },

    // Set up watchers for dev server
    configureServer(server) {
      // Set up enum watcher
      setupEnumWatcher({
        enumsDir,
        cwd,
        delivery,
        server,
      });

      // Set up route watcher
      setupRouteWatcher({
        routesDir,
        cwd,
        delivery,
        server,
        onTable: (table) => {
          routeTable = table;
        },
      });

      // Set up resource watcher
      setupResourceWatcher({
        resourcesDir,
        modelsDir,
        cwd,
        delivery,
        server,
        strict,
      });

      // Set up page-props watcher (controllers + middleware)
      setupPageWatcher({
        controllersDir,
        middlewareDir,
        resourcesDir,
        modelsDir,
        cwd,
        delivery,
        server,
        strict,
      });
    },
  };

  // A companion plugin runs the same codemod at `enforce: 'post'`, AFTER plugin-vue /
  // plugin-svelte compile the component and esbuild strips TS, so bare `route()` calls in
  // Vue/Svelte modules get rewritten too. Id ownership is mutually exclusive with the pre
  // pass (see shouldTransformPre / shouldTransformPost).
  const post: Plugin = {
    name: `${name}:post`,
    enforce: 'post',

    transform(code, id) {
      return transformRoutesPost(code, id, routeTable);
    },
  };

  return [main, post];
}
