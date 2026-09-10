import { join, basename } from 'node:path';
import type { ViteDevServer } from 'vite';
import type { Delivery } from '../delivery/index.js';
import { VIRTUAL_PREFIX } from '../delivery/index.js';
import { registerEnums, ENUMS_MODULE_ID } from '../generators/enums.js';
import { getPhpFiles } from '../utils/file.js';
import { logError, logFileChange, logRegeneration } from '../utils/banner.js';
import { setupFileWatcher } from './watch.js';

export type EnumWatcherOptions = {
  enumsDir: string;
  cwd: string;
  delivery: Delivery;
  server: ViteDevServer;
};

/**
 * Set up a watcher for enum files. On adding, editing, or deleting a PHP enum it re-collects
 * the enums, re-registers the `@ferry/enums` virtual module and its d.ts block, rewrites the
 * ambient types, and invalidates the virtual module in Vite's graph to trigger HMR.
 */
export function setupEnumWatcher(options: EnumWatcherOptions): void {
  const { enumsDir, cwd, delivery, server } = options;

  setupFileWatcher(server, {
    patterns: [join(enumsDir, '*.php')],
    initialFiles: getPhpFiles(enumsDir).map((f) => join(enumsDir, f)),
    owns: (filePath) => filePath.startsWith(enumsDir),
    onChange: (filePath) => {
      try {
        logFileChange('enums', basename(filePath));

        // Re-collect and re-register runtime + types, then rewrite the ambient file.
        registerEnums({ enumsDir, cwd, delivery });
        delivery.writeTypes();

        // Invalidate the virtual module so importers get the new runtime over HMR.
        const mod = server.moduleGraph.getModuleById(VIRTUAL_PREFIX + ENUMS_MODULE_ID);
        if (mod) {
          server.reloadModule(mod);
        } else {
          server.ws.send({ type: 'full-reload' });
        }

        logRegeneration('enums');
      } catch (e) {
        logError('enums', 'Error regenerating enum types', e);
      }
    },
  });
}
