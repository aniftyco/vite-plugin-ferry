import { join, basename } from 'node:path';
import type { ViteDevServer } from 'vite';
import type { Delivery } from '../delivery/index.js';
import { VIRTUAL_PREFIX } from '../delivery/index.js';
import { registerResources, RESOURCES_MODULE_ID } from '../generators/resources.js';
import { logError, logFileChange, logRegeneration } from '../utils/banner.js';

export type ResourceWatcherOptions = {
  resourcesDir: string;
  modelsDir: string;
  cwd: string;
  delivery: Delivery;
  server: ViteDevServer;
  strict?: boolean;
};

/**
 * Watch the app's resource and model files. On a change it re-collects and re-merges the
 * resources, re-registers the `@ferry/resources` virtual module and its d.ts block,
 * rewrites the ambient types, and invalidates the virtual module in Vite's graph — resource
 * types are type-only, so invalidating the one module (with a full-reload fallback) is enough.
 */
export function setupResourceWatcher(options: ResourceWatcherOptions): void {
  const { resourcesDir, modelsDir, cwd, delivery, server, strict } = options;

  server.watcher.add(join(resourcesDir, '*.php'));
  server.watcher.add(join(modelsDir, '*.php'));

  server.watcher.on('change', (filePath: string) => {
    if (!filePath.startsWith(resourcesDir) && !filePath.startsWith(modelsDir)) return;

    try {
      const fileType = filePath.startsWith(modelsDir) ? 'model' : 'resource';
      logFileChange(fileType, basename(filePath));

      registerResources({ resourcesDir, modelsDir, cwd, delivery, strict });
      delivery.writeTypes();

      const mod = server.moduleGraph.getModuleById(VIRTUAL_PREFIX + RESOURCES_MODULE_ID);
      if (mod) {
        server.reloadModule(mod);
      } else {
        server.ws.send({ type: 'full-reload' });
      }

      logRegeneration('resources');
    } catch (e) {
      logError('resources', 'Error regenerating resource types', e);
    }
  });
}
