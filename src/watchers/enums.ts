import { join, basename } from 'node:path';
import type { ViteDevServer } from 'vite';
import type { Delivery } from '../delivery/index.js';
import { VIRTUAL_PREFIX } from '../delivery/index.js';
import { registerEnums, ENUMS_MODULE_ID } from '../generators/enums.js';
import { registerForms } from '../generators/forms.js';
import { registerPages } from '../generators/pages.js';
import { registerResources } from '../generators/resources.js';
import { getPhpFiles } from '../utils/file.js';
import { logError, logFileChange, logRegeneration } from '../utils/banner.js';
import { setupFileWatcher } from './watch.js';

export type EnumWatcherOptions = {
  enumsDir: string;
  cwd: string;
  delivery: Delivery;
  server: ViteDevServer;
  /**
   * The enum-dependent generators. Their d.ts blocks embed `<Enum>Value` types and
   * `import { … } from '@ferry/enums'`, so an enum edit — especially a rename or delete —
   * must re-register them too, or their blocks (and any enum import) go stale in the ambient
   * file until an unrelated source file changes.
   */
  resourcesDir: string;
  modelsDir: string;
  controllersDir: string;
  middlewareDir: string;
  requestsDir: string;
  strict?: boolean;
};

/**
 * Set up a watcher for enum files. On adding, editing, or deleting a PHP enum it re-collects
 * the enums, re-registers the `@ferry/enums` virtual module and its d.ts block, rewrites the
 * ambient types, and invalidates the virtual module in Vite's graph to trigger HMR. The
 * enum-dependent generators (resources, pages, forms) are re-registered in the same pass so
 * their `<Enum>Value` references and `@ferry/enums` imports never lag behind an enum change.
 */
export function setupEnumWatcher(options: EnumWatcherOptions): void {
  const { enumsDir, cwd, delivery, server, resourcesDir, modelsDir, controllersDir, middlewareDir, requestsDir, strict } =
    options;

  setupFileWatcher(server, {
    patterns: [join(enumsDir, '*.php')],
    initialFiles: getPhpFiles(enumsDir).map((f) => join(enumsDir, f)),
    owns: (filePath) => filePath.startsWith(enumsDir),
    onChange: (filePath) => {
      try {
        logFileChange('enums', basename(filePath));

        // Re-collect and re-register the enum runtime + types, then refresh every generator
        // whose d.ts block references enums so a rename/delete can't leave a dangling import.
        registerEnums({ enumsDir, cwd, delivery });
        registerResources({ resourcesDir, modelsDir, cwd, delivery, strict });
        registerPages({ controllersDir, middlewareDir, resourcesDir, modelsDir, cwd, delivery, strict });
        registerForms({ requestsDir, cwd, delivery, strict });
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
