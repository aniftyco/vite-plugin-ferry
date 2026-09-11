import { join, basename } from 'node:path';
import type { ViteDevServer } from 'vite';
import type { Delivery } from '../delivery/index.js';
import { VIRTUAL_PREFIX } from '../delivery/index.js';
import { registerForms, FORMS_MODULE_ID } from '../generators/forms.js';
import { logError, logFileChange, logRegeneration } from '../utils/banner.js';
import { getPhpFilesRecursive } from '../utils/file.js';
import { setupFileWatcher } from './watch.js';

export type FormWatcherOptions = {
  requestsDir: string;
  cwd: string;
  delivery: Delivery;
  server: ViteDevServer;
  strict?: boolean;
};

/**
 * Watch the app's form-request files. On adding, editing, or deleting one it re-collects and
 * re-builds the forms, re-registers the `@ferry/forms` virtual module and its d.ts block,
 * rewrites the ambient types, and invalidates the virtual module in Vite's graph — form types
 * are type-only, so invalidating the one module (with a full-reload fallback) is enough.
 * Requests are watched recursively to match the recursive collection in the generator.
 */
export function setupFormWatcher(options: FormWatcherOptions): void {
  const { requestsDir, cwd, delivery, server, strict } = options;

  setupFileWatcher(server, {
    patterns: [join(requestsDir, '**/*.php')],
    initialFiles: getPhpFilesRecursive(requestsDir),
    owns: (filePath) => filePath.startsWith(requestsDir),
    onChange: (filePath) => {
      try {
        logFileChange('request', basename(filePath));

        registerForms({ requestsDir, cwd, delivery, strict });
        delivery.writeTypes();

        const mod = server.moduleGraph.getModuleById(VIRTUAL_PREFIX + FORMS_MODULE_ID);
        if (mod) {
          server.reloadModule(mod);
        } else {
          server.ws.send({ type: 'full-reload' });
        }

        logRegeneration('forms');
      } catch (e) {
        logError('forms', 'Error regenerating form types', e);
      }
    },
  });
}
