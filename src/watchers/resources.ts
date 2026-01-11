import { join, basename } from 'node:path';
import type { ViteDevServer } from 'vite';
import { generateResources, type ResourceGeneratorOptions } from '../generators/resources.js';
import { logError, logFileChange, logRegeneration } from '../utils/banner.js';

export type ResourceWatcherOptions = ResourceGeneratorOptions & {
  server: ViteDevServer;
};

/**
 * Set up a watcher for resource and model files.
 */
export function setupResourceWatcher(options: ResourceWatcherOptions): void {
  const { resourcesDir, enumsDir, modelsDir, outputDir, packageName, cwd, server } = options;

  const resourcePattern = join(resourcesDir, '*.php');
  const modelPattern = join(modelsDir, '*.php');
  const generatedDtsPath = join(outputDir, 'index.d.ts');

  // Watch PHP resource and model files
  server.watcher.add(resourcePattern);
  server.watcher.add(modelPattern);

  // Also watch the generated .d.ts file
  server.watcher.add(generatedDtsPath);

  const handleChange = (filePath: string) => {
    if (filePath.startsWith(resourcesDir) || filePath.startsWith(modelsDir)) {
      try {
        const isModel = filePath.startsWith(modelsDir);
        const fileType = isModel ? 'model' : 'resource';

        logFileChange(fileType, basename(filePath));

        // Regenerate resource types
        generateResources({ resourcesDir, enumsDir, modelsDir, outputDir, packageName, cwd });

        // Tell Vite the generated type file changed
        // TypeScript will pick up changes automatically
        server.watcher.emit('change', generatedDtsPath);

        logRegeneration('resources');
      } catch (e) {
        logError('resources', 'Error regenerating resource types', e);
      }
    }
  };

  server.watcher.on('change', handleChange);
}
