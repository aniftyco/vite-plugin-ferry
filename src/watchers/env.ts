import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { ViteDevServer } from 'vite';
import type { Delivery } from '../delivery/index.js';
import { registerEnv } from '../generators/env.js';
import { logError, logFileChange, logRegeneration } from '../utils/banner.js';
import { setupFileWatcher } from './watch.js';

export type EnvWatcherOptions = {
  cwd: string;
  /** `false` mirrors Vite's own `envDir: false`, which disables `.env` file loading. */
  envDir: string | false;
  mode: string;
  delivery: Delivery;
  server: ViteDevServer;
};

/**
 * The `.env` files Vite reads for a mode, in the same order and shape as Vite's own env
 * loading: `.env`, `.env.local`, `.env.[mode]`, `.env.[mode].local`, resolved against `envDir`.
 */
function envFilesForMode(envDir: string, mode: string): string[] {
  return ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`].map((file) => join(envDir, file));
}

/**
 * Watch the app's `.env*` files. On adding, editing, or deleting one it re-loads the
 * `VITE_`-prefixed vars, re-registers the `ImportMetaEnv` d.ts block, rewrites the ambient
 * types, and triggers a full reload. Env types are type-only (no virtual runtime module), so
 * there's nothing to invalidate in the module graph — a full reload is enough to surface the
 * new declarations.
 */
export function setupEnvWatcher(options: EnvWatcherOptions): void {
  const { cwd, envDir, mode, delivery, server } = options;

  // With `envDir: false` Vite loads no `.env` files (only pre-set process env), so there's
  // nothing on disk to watch.
  if (envDir === false) return;

  const envFiles = envFilesForMode(envDir, mode);
  const owned = new Set(envFiles);

  setupFileWatcher(server, {
    patterns: envFiles,
    initialFiles: envFiles.filter((file) => existsSync(file)),
    owns: (filePath) => owned.has(filePath),
    onChange: (filePath) => {
      try {
        logFileChange('env', basename(filePath));

        registerEnv({ cwd, mode, envDir, delivery });
        delivery.writeTypes();

        server.ws.send({ type: 'full-reload' });

        logRegeneration('env');
      } catch (e) {
        logError('env', 'Error regenerating env types', e);
      }
    },
  });
}
