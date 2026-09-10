import { join, basename } from 'node:path';
import type { ViteDevServer } from 'vite';
import type { Delivery } from '../delivery/index.js';
import { VIRTUAL_PREFIX } from '../delivery/index.js';
import { registerResources, RESOURCES_MODULE_ID } from '../generators/resources.js';
import { getPhpFiles, getPhpFilesRecursive } from '../utils/file.js';
import { logError, logFileChange, logRegeneration } from '../utils/banner.js';
import { setupFileWatcher } from './watch.js';

export type ResourceWatcherOptions = {
  resourcesDir: string;
  modelsDir: string;
  cwd: string;
  delivery: Delivery;
  server: ViteDevServer;
  strict?: boolean;
};

/**
 * Watch the app's resource and model files. On adding, editing, or deleting one it re-collects
 * and re-merges the resources, re-registers the `@ferry/resources` virtual module and its d.ts
 * block, rewrites the ambient types, and invalidates the virtual module in Vite's graph —
 * resource types are type-only, so invalidating the one module (with a full-reload fallback) is
 * enough. Resources are watched recursively to match the recursive collection in the generator.
 */
export function setupResourceWatcher(options: ResourceWatcherOptions): void {
  const { resourcesDir, modelsDir, cwd, delivery, server, strict } = options;

  setupFileWatcher(server, {
    patterns: [join(resourcesDir, '**/*.php'), join(modelsDir, '*.php')],
    initialFiles: [...getPhpFilesRecursive(resourcesDir), ...getPhpFiles(modelsDir).map((f) => join(modelsDir, f))],
    owns: (filePath) => filePath.startsWith(resourcesDir) || filePath.startsWith(modelsDir),
    onChange: (filePath) => {
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
    },
  });
}
