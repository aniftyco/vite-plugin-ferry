import { join } from 'node:path';
import type { Plugin } from 'vite';
import { generateEnums } from './generators/enums.js';
import { generateResources } from './generators/resources.js';
import { setupEnumWatcher } from './watchers/enums.js';
import { setupResourceWatcher } from './watchers/resources.js';

export type ResourceTypesPluginOptions = {
  cwd?: string;
};

/**
 * Vite plugin for generating TypeScript types from Laravel PHP files.
 *
 * This plugin generates separate packages for each type:
 * - @app/enums - PHP enums with labels
 * - @app/resources - Laravel JsonResource types
 * - @app/schemas - (future) Zod schemas from FormRequests
 */
export default function ferry(
  options: ResourceTypesPluginOptions = {
    cwd: process.cwd(),
  }
): Plugin {
  const namespace = '@ferry';
  const name = 'vite-plugin-ferry';

  // Directory paths
  const enumsDir = join(options.cwd, 'app/Enums');
  const resourcesDir = join(options.cwd, 'app/Http/Resources');
  const modelsDir = join(options.cwd, 'app/Models');

  // Output directories for each package
  const enumsOutputDir = join(options.cwd, 'node_modules', ...namespace.split('/'), 'enums');
  const resourcesOutputDir = join(options.cwd, 'node_modules', ...namespace.split('/'), 'resources');

  /**
   * Generate all packages.
   */
  function generateAll() {
    // Generate @app/enums package
    generateEnums({
      enumsDir,
      outputDir: enumsOutputDir,
      packageName: `${namespace}/enums`,
    });

    // Generate @app/resources package
    generateResources({
      resourcesDir,
      enumsDir,
      modelsDir,
      outputDir: resourcesOutputDir,
      packageName: `${namespace}/resources`,
    });
  }

  return {
    name,
    enforce: 'pre',

    // Run generation during config resolution so files exist before other plugins need them
    config() {
      try {
        generateAll();
      } catch (e) {
        console.error(`[${name}] Error generating types during config():`, e);
      }
      return null;
    },

    // Run generation when build starts
    buildStart() {
      try {
        generateAll();
      } catch (e) {
        console.error(`[${name}] Error generating types during buildStart():`, e);
      }
    },

    // Set up watchers for dev server
    configureServer(server) {
      // Set up enum watcher
      setupEnumWatcher({
        enumsDir,
        outputDir: enumsOutputDir,
        packageName: `${namespace}/enums`,
        server,
      });

      // Set up resource watcher
      setupResourceWatcher({
        resourcesDir,
        enumsDir,
        modelsDir,
        outputDir: resourcesOutputDir,
        packageName: `${namespace}/resources`,
        server,
      });
    },
  };
}
