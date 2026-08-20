import { join, basename } from 'node:path';
import type { ViteDevServer } from 'vite';
import type { Delivery } from '../delivery/index.js';
import { VIRTUAL_PREFIX } from '../delivery/index.js';
import { registerPages, PAGES_MODULE_ID } from '../generators/pages.js';
import { logError, logFileChange, logRegeneration } from '../utils/banner.js';

export type PageWatcherOptions = {
  controllersDir: string;
  middlewareDir: string;
  resourcesDir: string;
  modelsDir: string;
  cwd: string;
  delivery: Delivery;
  server: ViteDevServer;
  strict?: boolean;
};

/**
 * Watch the app's controller and middleware files. On a change it re-analyzes the
 * `Inertia::render(...)` calls and `share()` data, re-registers the `@ferry/pages` virtual
 * module, its d.ts block, and the `@inertiajs/core` augmentation file, rewrites the ambient
 * types, and invalidates the virtual module — page types are type-only, so invalidating the
 * one module (with a full-reload fallback) is enough.
 */
export function setupPageWatcher(options: PageWatcherOptions): void {
  const { controllersDir, middlewareDir, resourcesDir, modelsDir, cwd, delivery, server, strict } = options;

  server.watcher.add(join(controllersDir, '**/*.php'));
  server.watcher.add(join(middlewareDir, '*.php'));

  server.watcher.on('change', (filePath: string) => {
    if (!filePath.startsWith(controllersDir) && !filePath.startsWith(middlewareDir)) return;

    try {
      const fileType = filePath.startsWith(middlewareDir) ? 'middleware' : 'controller';
      logFileChange(fileType, basename(filePath));

      registerPages({ controllersDir, middlewareDir, resourcesDir, modelsDir, cwd, delivery, strict });
      delivery.writeTypes();

      const mod = server.moduleGraph.getModuleById(VIRTUAL_PREFIX + PAGES_MODULE_ID);
      if (mod) {
        server.reloadModule(mod);
      } else {
        server.ws.send({ type: 'full-reload' });
      }

      logRegeneration('pages');
    } catch (e) {
      logError('pages', 'Error regenerating page types', e);
    }
  });
}
