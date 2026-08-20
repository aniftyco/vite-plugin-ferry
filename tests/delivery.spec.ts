import { describe, it, expect } from 'vitest';
import { VirtualModuleRegistry, DtsRegistry, ModuleFileRegistry, VIRTUAL_PREFIX } from '../src/delivery/registry.js';
import { assembleAmbientTypes } from '../src/delivery/ambient-types.js';
import { createDelivery } from '../src/delivery/index.js';

describe('VirtualModuleRegistry', () => {
  it('resolves a registered id to its \\0-prefixed virtual id', () => {
    const registry = new VirtualModuleRegistry();
    registry.register('@ferry/enums', 'export {};');

    expect(registry.resolveId('@ferry/enums')).toBe(`${VIRTUAL_PREFIX}@ferry/enums`);
  });

  it('returns null when resolving an unregistered id', () => {
    const registry = new VirtualModuleRegistry();
    expect(registry.resolveId('@ferry/enums')).toBeNull();
  });

  it('loads source for a \\0-prefixed id, stripping the prefix', () => {
    const registry = new VirtualModuleRegistry();
    registry.register('@ferry/enums', 'export const answer = 42;');

    expect(registry.load(`${VIRTUAL_PREFIX}@ferry/enums`)).toBe('export const answer = 42;');
  });

  it('returns null loading an id without the \\0 prefix', () => {
    const registry = new VirtualModuleRegistry();
    registry.register('@ferry/enums', 'export {};');

    expect(registry.load('@ferry/enums')).toBeNull();
  });

  it('returns null loading a \\0-prefixed id that was never registered', () => {
    const registry = new VirtualModuleRegistry();
    expect(registry.load(`${VIRTUAL_PREFIX}@ferry/unknown`)).toBeNull();
  });

  it('resolves function sources lazily on load', () => {
    const registry = new VirtualModuleRegistry();
    let calls = 0;
    registry.register('@ferry/enums', () => {
      calls++;
      return `export const calls = ${calls};`;
    });

    expect(calls).toBe(0);
    expect(registry.load(`${VIRTUAL_PREFIX}@ferry/enums`)).toBe('export const calls = 1;');
    expect(registry.load(`${VIRTUAL_PREFIX}@ferry/enums`)).toBe('export const calls = 2;');
  });

  it('overwrites an id when re-registered', () => {
    const registry = new VirtualModuleRegistry();
    registry.register('@ferry/enums', 'old');
    registry.register('@ferry/enums', 'new');

    expect(registry.load(`${VIRTUAL_PREFIX}@ferry/enums`)).toBe('new');
  });
});

describe('DtsRegistry', () => {
  it('renders registered blocks in registration order', () => {
    const registry = new DtsRegistry();
    registry.register('a', 'block-a');
    registry.register('b', () => 'block-b');

    expect(registry.render()).toEqual(['block-a', 'block-b']);
  });

  it('overwrites a block in place when re-registered under the same key', () => {
    const registry = new DtsRegistry();
    registry.register('a', 'first');
    registry.register('b', 'second');
    registry.register('a', 'first-updated');

    expect(registry.render()).toEqual(['first-updated', 'second']);
  });
});

describe('ModuleFileRegistry', () => {
  it('renders registered files with resolved content', () => {
    const registry = new ModuleFileRegistry();
    registry.register('inertia.d.ts', () => 'export {};');

    expect(registry.render()).toEqual([{ fileName: 'inertia.d.ts', content: 'export {};' }]);
  });
});

describe('assembleAmbientTypes', () => {
  it('produces a script-style file with zero top-level import/export', () => {
    const output = assembleAmbientTypes({
      blocks: [
        `declare module '@ferry/enum' {\n  export class Enum {}\n}`,
        `declare module '@ferry/enums' {}`,
      ],
    });

    const topLevel = output.split('\n').filter((line) => /^(import|export)\b/.test(line));
    expect(topLevel).toEqual([]);
  });

  it('includes every declaration block it was given', () => {
    const output = assembleAmbientTypes({
      blocks: [`declare module '@ferry/enum' {}`, `declare module '@ferry/route' {}`],
    });

    expect(output).toContain(`declare module '@ferry/enum' {}`);
    expect(output).toContain(`declare module '@ferry/route' {}`);
  });

  it('emits a triple-slash reference for each separate module file', () => {
    const output = assembleAmbientTypes({
      blocks: [`declare module '@ferry/enums' {}`],
      moduleFiles: [{ fileName: 'inertia.d.ts', content: `import '@inertiajs/core';` }],
    });

    expect(output).toContain('/// <reference path="./inertia.d.ts" />');
  });

  it('places triple-slash references before any other content', () => {
    const output = assembleAmbientTypes({
      blocks: [`declare module '@ferry/enums' {}`],
      moduleFiles: [{ fileName: 'inertia.d.ts', content: '' }],
    });

    const firstMeaningfulLine = output.split('\n').find((line) => line.trim().length > 0);
    expect(firstMeaningfulLine).toBe('/// <reference path="./inertia.d.ts" />');
  });

  it('omits triple-slash references when there are no module files', () => {
    const output = assembleAmbientTypes({ blocks: [`declare module '@ferry/enums' {}`] });
    expect(output).not.toContain('/// <reference');
  });
});

describe('createDelivery', () => {
  it('resolves the concrete and no-disk-package ferry ids to their virtual id', () => {
    const delivery = createDelivery('/tmp/project');

    for (const id of ['@ferry/enum', '@ferry/route', '@ferry/pages']) {
      expect(delivery.resolveId(id)).toBe(`${VIRTUAL_PREFIX}${id}`);
    }
  });

  it('does NOT resolve disk-backed ids while their real content is unregistered, so the disk package wins', () => {
    const delivery = createDelivery('/tmp/project');

    // No placeholder shadows the still-on-disk generated packages of the same name.
    expect(delivery.resolveId('@ferry/enums')).toBeNull();
    expect(delivery.resolveId('@ferry/resources')).toBeNull();
  });

  it('resolves a disk-backed id once its real content is registered (the step-2 seam)', () => {
    const delivery = createDelivery('/tmp/project');
    delivery.virtual.register('@ferry/enums', 'export {};');

    expect(delivery.resolveId('@ferry/enums')).toBe(`${VIRTUAL_PREFIX}@ferry/enums`);
  });

  it('serves the concrete Enum base class at @ferry/enum', () => {
    const delivery = createDelivery('/tmp/project');
    const source = delivery.load(`${VIRTUAL_PREFIX}@ferry/enum`);

    expect(source).toContain('export class Enum');
    expect(source).toContain('static from(value)');
  });

  it('serves placeholder runtime for no-disk-package modules not yet built', () => {
    const delivery = createDelivery('/tmp/project');
    expect(delivery.load(`${VIRTUAL_PREFIX}@ferry/route`)).toBe('export {};\n');
  });

  it('does not resolve ids it has not registered', () => {
    const delivery = createDelivery('/tmp/project');
    expect(delivery.resolveId('@ferry/nope')).toBeNull();
  });

  it('assembles the concrete Enum base d.ts block into a script-style ambient file', () => {
    const delivery = createDelivery('/tmp/project');
    const output = assembleAmbientTypes({ blocks: delivery.dts.render() });

    const topLevel = output.split('\n').filter((line) => /^(import|export)\b/.test(line));
    expect(topLevel).toEqual([]);
    expect(output).toContain(`declare module '@ferry/enum' {`);
  });
});
