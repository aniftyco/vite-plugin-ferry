import { join, basename } from 'node:path';
import type { ViteDevServer } from 'vite';
import { generateEnums, type EnumGeneratorOptions } from '../generators/enums.js';
import { logError, logFileChange, logRegeneration } from '../utils/banner.js';

export type EnumWatcherOptions = EnumGeneratorOptions & {
  server: ViteDevServer;
};

/**
 * Set up a watcher for enum files.
 */
export function setupEnumWatcher(options: EnumWatcherOptions): void {
  const { enumsDir, outputDir, packageName, server } = options;

  const enumPattern = join(enumsDir, '*.php');
  const generatedJsPath = join(outputDir, 'index.js');

  // Watch PHP enum files
  server.watcher.add(enumPattern);

  // Also watch the generated JS file (for HMR)
  server.watcher.add(generatedJsPath);

  server.watcher.on('change', (filePath: string) => {
    if (filePath.startsWith(enumsDir)) {
      try {
        logFileChange('enums', basename(filePath));

        // Regenerate enum files
        generateEnums({ enumsDir, outputDir, packageName });

        // Tell Vite the generated file changed (triggers normal HMR)
        server.watcher.emit('change', generatedJsPath);

        logRegeneration('enums');
      } catch (e) {
        logError('enums', 'Error regenerating enum types', e);
      }
    }
  });
}
