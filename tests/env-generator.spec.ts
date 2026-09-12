import { describe, it, expect } from 'vitest';
import { generateEnvDtsBlock } from '../src/generators/env.js';
import { dedent } from './utils.js';

describe('generateEnvDtsBlock', () => {
  it('emits a top-level ImportMetaEnv interface with keys sorted', () => {
    expect(generateEnvDtsBlock({ VITE_FOO: 'x', VITE_BAR: 'y' })).toBe(
      dedent`
        interface ImportMetaEnv {
          readonly VITE_BAR: string;
          readonly VITE_FOO: string;
        }
      `.trimEnd()
    );
  });

  it('emits an empty interface when there are no env vars', () => {
    expect(generateEnvDtsBlock({})).toBe('interface ImportMetaEnv {}');
  });

  it('types every key as string, never inferring the value', () => {
    const block = generateEnvDtsBlock({ VITE_COUNT: '3', VITE_FLAG: 'true' });

    expect(block).toContain('readonly VITE_COUNT: string;');
    expect(block).toContain('readonly VITE_FLAG: string;');
    expect(block).not.toContain(': 3');
    expect(block).not.toContain('true');
  });

  it('emits keys only and never the env value (no-leak guarantee)', () => {
    const block = generateEnvDtsBlock({ VITE_SECRET: 'super-secret-value' });

    expect(block).toContain('VITE_SECRET');
    expect(block).toContain('string');
    expect(block).not.toContain('super-secret-value');
  });

  it('is script-safe: no top-level import or export', () => {
    const block = generateEnvDtsBlock({ VITE_FOO: 'x' });

    expect(block).not.toMatch(/^\s*import\b/m);
    expect(block).not.toMatch(/^\s*export\b/m);
  });
});
