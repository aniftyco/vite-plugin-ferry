import { join } from 'node:path';
import { VirtualModuleRegistry, DtsRegistry, ModuleFileRegistry } from './registry.js';
import { writeAmbientTypes } from './ambient-types.js';
import { ENUM_BASE_RUNTIME, ENUM_BASE_DTS } from './enum-base.js';

export * from './registry.js';
export * from './ambient-types.js';
export * from './enum-base.js';

/** The ferry virtual module ids served at runtime. */
export const FERRY_MODULE_IDS = ['@ferry/enums', '@ferry/enum', '@ferry/resources', '@ferry/route', '@ferry/pages'] as const;

/** Runtime placeholder for feature modules whose real content arrives in a later build-order step. */
const PLACEHOLDER_RUNTIME = 'export {};\n';

/** d.ts placeholder: an empty `declare module` block, safe in the script-style ambient file. */
const placeholderDts = (id: string): string => `declare module '${id}' {}`;

/**
 * The delivery layer: the virtual-module, d.ts, and module-file registries plus the
 * plugin-facing `resolveId`/`load`/`writeTypes` operations. Feature generators plug
 * their content in by re-registering the same id/key on the exposed registries.
 */
export type Delivery = {
  virtual: VirtualModuleRegistry;
  dts: DtsRegistry;
  moduleFiles: ModuleFileRegistry;
  resolveId(id: string): string | null;
  load(id: string): string | null;
  writeTypes(): void;
};

/**
 * Seed the registries with the delivery defaults: the concrete `@ferry/enum` base
 * class, and placeholders for ferry modules with no feature generator yet, so the
 * plumbing is exercisable before that generator lands. Feature generators (enums,
 * resources) register their own ids in `generateAll()` and overwrite these.
 */
function registerDefaults(virtual: VirtualModuleRegistry, dts: DtsRegistry): void {
  virtual.register('@ferry/enum', ENUM_BASE_RUNTIME);
  dts.register('@ferry/enum', ENUM_BASE_DTS);

  for (const id of ['@ferry/route', '@ferry/pages']) {
    virtual.register(id, PLACEHOLDER_RUNTIME);
    dts.register(id, placeholderDts(id));
  }
}

/**
 * Construct the delivery layer for a project rooted at `cwd`. Ambient types are
 * written to `node_modules/@types/vite-plugin-ferry`, which TypeScript 5.x auto-loads.
 */
export function createDelivery(cwd: string): Delivery {
  const virtual = new VirtualModuleRegistry();
  const dts = new DtsRegistry();
  const moduleFiles = new ModuleFileRegistry();

  registerDefaults(virtual, dts);

  const typesDir = join(cwd, 'node_modules', '@types', 'vite-plugin-ferry');

  return {
    virtual,
    dts,
    moduleFiles,
    resolveId: (id) => virtual.resolveId(id),
    load: (id) => virtual.load(id),
    writeTypes() {
      writeAmbientTypes(typesDir, {
        blocks: dts.render(),
        moduleFiles: moduleFiles.render(),
      });
    },
  };
}
