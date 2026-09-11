import { join } from 'node:path';
import type { LogLevel, Plugin } from 'vite';
import { transformRoutes, transformRoutesPost } from './codemod/routes.js';
import { createDelivery } from './delivery/index.js';
import { registerEnums } from './generators/enums.js';
import { registerForms } from './generators/forms.js';
import { registerPages } from './generators/pages.js';
import { registerResources } from './generators/resources.js';
import { registerRoutes, type RouteTable } from './generators/routes.js';
import { logError, setVerbosity, type Verbosity } from './utils/banner.js';
import { setupEnumWatcher } from './watchers/enums.js';
import { setupFormWatcher } from './watchers/forms.js';
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
   * How much ferry logs, ordered by severity: `silent` < `error` < `warn` < `info`. A
   * message prints only when its severity is at or below this level, so `error` shows only
   * errors, `warn` adds warnings, and `info` (the default) shows everything. Build-failing
   * errors always throw regardless of this setting. When unset, ferry inherits vite's own
   * `logLevel`, falling back to `info`.
   */
  verbosity?: Verbosity;
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

  // Resolve the effective verbosity: the explicit option wins, then vite's own
  // `logLevel` (its values match ours exactly), then `info`. Vite's LogLevel and
  // our Verbosity are the same string union, so this is a direct pass-through.
  function resolveVerbosity(viteLogLevel?: LogLevel): Verbosity {
    return options.verbosity ?? viteLogLevel ?? 'info';
  }

  // Directory paths
  const enumsDir = join(cwd, 'app/Enums');
  const resourcesDir = join(cwd, 'app/Http/Resources');
  const modelsDir = join(cwd, 'app/Models');
  const routesDir = join(cwd, 'routes');
  const controllersDir = join(cwd, 'app/Http/Controllers');
  const middlewareDir = join(cwd, 'app/Http/Middleware');
  const requestsDir = join(cwd, 'app/Http/Requests');

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

    // Register @ferry/forms (per-FormRequest data-shape types) for typed useForm<T>().
    registerForms({ requestsDir, cwd, delivery, strict });

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
      return transformRoutes(code, id, routeTable);
    },

    // Generate once per startup, during config resolution, so the ambient d.ts and
    // virtual-module registrations exist before any consumer needs them. `config` fires
    // on both `vite dev` and `vite build`, and dev-time freshness is the watchers' job,
    // so this is the sole generation pass — no duplicate PHP subprocess spawns.
    config(userConfig) {
      // The generation pass below can log, and `config` fires before `configResolved`,
      // so resolve and apply the level here first — reading the incoming config's
      // `logLevel` as the fallback when no explicit `verbosity` was given.
      setVerbosity(resolveVerbosity(userConfig.logLevel));

      try {
        generateAll();
      } catch (e) {
        logError(name, 'Error generating types during config()', e);
      }

      return {
        optimizeDeps: {
          exclude: [
            `${namespace}/enums`,
            `${namespace}/resources`,
            `${namespace}/route`,
            `${namespace}/pages`,
            `${namespace}/forms`,
          ],
        },
      };
    },

    // Authoritative resolution once vite has merged config. The `config` hook already
    // set a level for the generation pass; re-apply from the resolved `logLevel` so the
    // dev watchers set up below honor it too.
    configResolved(config) {
      setVerbosity(resolveVerbosity(config.logLevel));
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

      // Set up form-request watcher
      setupFormWatcher({
        requestsDir,
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
