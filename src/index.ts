import { join } from 'node:path';
import type { Plugin } from 'vite';
import { generateEnums } from './generators/enums.js';
import { generateResources } from './generators/resources.js';
import { setupEnumWatcher } from './watchers/enums.js';
import { setupResourceWatcher } from './watchers/resources.js';

export type ResourceTypesPluginOptions = {
  cwd?: string;
  prettyPrint?: boolean;
};

/**
 * Vite plugin for generating TypeScript types from Laravel PHP files.
 *
 * This plugin generates separate packages for each type:
 * - @app/enums - PHP enums with labels
 * - @app/resources - Laravel JsonResource types
 * - @app/schemas - (future) Zod schemas from FormRequests
 */
export default function ferry(options: ResourceTypesPluginOptions = {}): Plugin {
  const namespace = '@ferry';
  const name = 'vite-plugin-ferry';

  // Apply defaults
  const cwd = options.cwd ?? process.cwd();
  const prettyPrint = options.prettyPrint ?? true;

  // Directory paths
  const enumsDir = join(cwd, 'app/Enums');
  const resourcesDir = join(cwd, 'app/Http/Resources');
  const modelsDir = join(cwd, 'app/Models');

  // Output directories for each package
  const enumsOutputDir = join(cwd, 'node_modules', ...namespace.split('/'), 'enums');
  const resourcesOutputDir = join(cwd, 'node_modules', ...namespace.split('/'), 'resources');

  /**
   * Generate all packages.
   */
  function generateAll() {
    // Generate @app/enums package
    generateEnums({
      enumsDir,
      outputDir: enumsOutputDir,
      packageName: `${namespace}/enums`,
      prettyPrint,
      cwd,
    });

    // Generate @app/resources package
    generateResources({
      resourcesDir,
      enumsDir,
      modelsDir,
      outputDir: resourcesOutputDir,
      packageName: `${namespace}/resources`,
      prettyPrint,
      cwd,
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

      return {
        optimizeDeps: {
          exclude: [`${namespace}/enums`, `${namespace}/resources`],
        },
      };
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
        cwd,
        server,
      });

      // Set up resource watcher
      setupResourceWatcher({
        resourcesDir,
        enumsDir,
        modelsDir,
        outputDir: resourcesOutputDir,
        packageName: `${namespace}/resources`,
        cwd,
        server,
      });
    },
  };
}
