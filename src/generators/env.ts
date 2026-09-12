import { loadEnv } from 'vite';
import type { Delivery } from '../delivery/index.js';

/** The d.ts registry key the `import.meta.env` types are delivered under. Type-only; no virtual module. */
export const ENV_DTS_KEY = 'import-meta-env';

export type EnvRegisterOptions = {
  cwd: string;
  mode: string;
  /** `false` mirrors Vite's own `envDir: false`, which disables `.env` file loading. */
  envDir: string | false;
  delivery: Delivery;
};

/**
 * The top-level `interface ImportMetaEnv` block for the ambient `index.d.ts`. Every
 * `VITE_`-prefixed key is typed `readonly <KEY>: string` — `import.meta.env` values are
 * always strings at runtime, so the type never infers boolean/number and never emits the
 * value itself (keys only, so no secret leaks). Keys are sorted for deterministic output.
 * The block is a plain top-level interface (not a `declare module`) so it declaration-merges
 * with `vite/client`'s global `ImportMetaEnv`; being top-level and import-free keeps the
 * ambient file script-style. Empty input emits `interface ImportMetaEnv {}`, a no-op merge.
 */
export function generateEnvDtsBlock(vars: Record<string, string>): string {
  const keys = Object.keys(vars).sort();
  if (keys.length === 0) {
    return 'interface ImportMetaEnv {}';
  }

  const members = keys.map((key) => `  readonly ${key}: string;`).join('\n');
  return `interface ImportMetaEnv {\n${members}\n}`;
}

/**
 * Load the project's `VITE_`-prefixed env vars via Vite's own loader and register the
 * `ImportMetaEnv` d.ts block with the delivery layer. Type-only — no virtual module or
 * module file. The `'VITE_'` prefix arg makes `loadEnv` return only prefixed vars, so no
 * unprefixed secrets are read. Does not write the ambient file; the caller runs `writeTypes()`.
 */
export function registerEnv({ mode, envDir, delivery }: EnvRegisterOptions): void {
  const vars = loadEnv(mode, envDir, 'VITE_');
  delivery.dts.register(ENV_DTS_KEY, generateEnvDtsBlock(vars));
}
