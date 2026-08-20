import { join, basename } from 'node:path';
import type { ViteDevServer } from 'vite';
import type { Delivery } from '../delivery/index.js';
import { registerRoutes, type RouteTable } from '../generators/routes.js';
import { logError, logFileChange, logRegeneration } from '../utils/banner.js';

export type RouteWatcherOptions = {
  routesDir: string;
  cwd: string;
  delivery: Delivery;
  server: ViteDevServer;
  /** Called with the freshly built route table so the codemod uses the new data. */
  onTable: (table: RouteTable) => void;
};

/**
 * Watch the app's route files. On a change it re-runs `route:list`, re-registers the
 * `@ferry/route` runtime and its declarations, rewrites the ambient types, and triggers
 * a full reload — route patterns are inlined at call sites by the codemod, so a route
 * change requires re-transforming every module, not just invalidating one virtual module.
 */
export function setupRouteWatcher(options: RouteWatcherOptions): void {
  const { routesDir, cwd, delivery, server, onTable } = options;

  server.watcher.add(join(routesDir, '**/*.php'));

  server.watcher.on('change', (filePath: string) => {
    if (!filePath.startsWith(routesDir)) return;

    try {
      logFileChange('routes', basename(filePath));

      const table = registerRoutes({ cwd, delivery });
      onTable(table);
      delivery.writeTypes();

      server.ws.send({ type: 'full-reload' });

      logRegeneration('routes');
    } catch (e) {
      logError('routes', 'Error regenerating route types', e);
    }
  });
}
