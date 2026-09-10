import { join, basename } from 'node:path';
import type { ViteDevServer } from 'vite';
import type { Delivery } from '../delivery/index.js';
import { registerRoutes, type RouteTable } from '../generators/routes.js';
import { getPhpFilesRecursive } from '../utils/file.js';
import { logError, logFileChange, logRegeneration } from '../utils/banner.js';
import { setupFileWatcher } from './watch.js';

export type RouteWatcherOptions = {
  routesDir: string;
  cwd: string;
  delivery: Delivery;
  server: ViteDevServer;
  /** Called with the freshly built route table so the codemod uses the new data. */
  onTable: (table: RouteTable) => void;
};

/**
 * Watch the app's route files. On adding, editing, or deleting one it re-runs `route:list`,
 * re-registers the `@ferry/route` runtime and its declarations, rewrites the ambient types,
 * and triggers a full reload. Route patterns are inlined at call sites by the codemod, and
 * source modules don't import the PHP route files, so Vite's cached transforms would keep
 * serving the old inlined patterns — the whole module graph is invalidated before the reload
 * to force every module to re-transform against the new table.
 */
export function setupRouteWatcher(options: RouteWatcherOptions): void {
  const { routesDir, cwd, delivery, server, onTable } = options;

  setupFileWatcher(server, {
    patterns: [join(routesDir, '**/*.php')],
    initialFiles: getPhpFilesRecursive(routesDir),
    owns: (filePath) => filePath.startsWith(routesDir),
    onChange: (filePath) => {
      try {
        logFileChange('routes', basename(filePath));

        const table = registerRoutes({ cwd, delivery });
        onTable(table);
        delivery.writeTypes();

        // Clear cached transforms so re-transformed modules pick up the new inlined patterns.
        server.moduleGraph.invalidateAll();
        server.ws.send({ type: 'full-reload' });

        logRegeneration('routes');
      } catch (e) {
        logError('routes', 'Error regenerating route types', e);
      }
    },
  });
}
