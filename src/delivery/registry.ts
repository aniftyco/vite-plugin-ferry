/**
 * The `\0` prefix Rollup/Vite convention marks a resolved id as virtual, so no
 * other plugin treats it as a real file on disk.
 */
export const VIRTUAL_PREFIX = '\0';

/** A module's source: a fixed string, or a function producing it on demand. */
export type ModuleSource = string | (() => string);

/**
 * Registry of ferry virtual modules (runtime): a map from bare virtual id
 * (`@ferry/...`) to the source that `load()` serves. Feature generators register
 * their content here; the plugin's `resolveId`/`load` hooks read from it.
 */
export class VirtualModuleRegistry {
  private sources = new Map<string, ModuleSource>();

  /** Register (or overwrite) the source for a bare virtual id. */
  register(id: string, source: ModuleSource): void {
    this.sources.set(id, source);
  }

  has(id: string): boolean {
    return this.sources.has(id);
  }

  ids(): string[] {
    return [...this.sources.keys()];
  }

  /** Map a bare virtual id to its internal `\0`-prefixed id, or null if unregistered. */
  resolveId(id: string): string | null {
    return this.sources.has(id) ? VIRTUAL_PREFIX + id : null;
  }

  /** Serve the source for a `\0`-prefixed id, or null if it isn't a registered virtual module. */
  load(resolvedId: string): string | null {
    if (!resolvedId.startsWith(VIRTUAL_PREFIX)) return null;
    const id = resolvedId.slice(VIRTUAL_PREFIX.length);
    const source = this.sources.get(id);
    if (source === undefined) return null;
    return typeof source === 'function' ? source() : source;
  }

  clear(): void {
    this.sources.clear();
  }
}

/** A d.ts block's source: a fixed string, or a function producing it on demand. */
export type DtsSource = string | (() => string);

/**
 * Registry of script-style declaration blocks assembled into the single ambient
 * `index.d.ts`. Each feature generator contributes its `declare module` block (or
 * top-level `declare function` / `interface`); the delivery layer joins them.
 */
export class DtsRegistry {
  private blocks = new Map<string, DtsSource>();

  /** Register (or overwrite) the block for a key (typically the module id it declares). */
  register(key: string, block: DtsSource): void {
    this.blocks.set(key, block);
  }

  has(key: string): boolean {
    return this.blocks.has(key);
  }

  keys(): string[] {
    return [...this.blocks.keys()];
  }

  /** All registered blocks as resolved strings, in registration order. */
  render(): string[] {
    return [...this.blocks.values()].map((b) => (typeof b === 'function' ? b() : b));
  }

  clear(): void {
    this.blocks.clear();
  }
}

/** A separate, module-style declaration file pulled into the program by a triple-slash reference. */
export type ModuleFile = {
  /** File name relative to the types dir, e.g. `inertia.d.ts`. */
  fileName: string;
  /** Module-style content — top-level `import`/`export` is allowed here. */
  content: string;
};

/**
 * Registry of separate module-style declaration files (e.g. the `InertiaConfig`
 * augmentation, which imports `@inertiajs/core` and so cannot live in the
 * script-style `index.d.ts`). Each is emitted as its own file and referenced from
 * `index.d.ts` via a triple-slash directive.
 */
export class ModuleFileRegistry {
  private files = new Map<string, DtsSource>();

  /** Register (or overwrite) a module file by name. */
  register(fileName: string, content: DtsSource): void {
    this.files.set(fileName, content);
  }

  has(fileName: string): boolean {
    return this.files.has(fileName);
  }

  fileNames(): string[] {
    return [...this.files.keys()];
  }

  /** All registered files with resolved content, in registration order. */
  render(): ModuleFile[] {
    return [...this.files.entries()].map(([fileName, content]) => ({
      fileName,
      content: typeof content === 'function' ? content() : content,
    }));
  }

  clear(): void {
    this.files.clear();
  }
}
