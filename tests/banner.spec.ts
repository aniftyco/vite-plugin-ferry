import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logError, logFileChange, logRegeneration, logWarn, setVerbosity } from '../src/utils/banner.js';
import ferry from '../src/index.js';
import { transformRoutes, RouteCodemodError } from '../src/codemod/routes.js';
import type { RouteTable } from '../src/generators/routes.js';

type Spies = {
  log: ReturnType<typeof vi.spyOn>;
  warn: ReturnType<typeof vi.spyOn>;
  error: ReturnType<typeof vi.spyOn>;
};

function spyConsole(): Spies {
  return {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
}

function emitAll(): void {
  logFileChange('pkg', 'file.php');
  logRegeneration('pkg');
  logWarn('pkg', 'a warning');
  logError('pkg', 'an error');
}

afterEach(() => {
  // Reset the module-level threshold so state doesn't leak between tests.
  setVerbosity('info');
  vi.restoreAllMocks();
});

describe('verbosity gating', () => {
  it('prints everything at info', () => {
    setVerbosity('info');
    const s = spyConsole();
    emitAll();
    expect(s.log).toHaveBeenCalledTimes(2); // logFileChange + logRegeneration
    expect(s.warn).toHaveBeenCalledTimes(1);
    expect(s.error).toHaveBeenCalledTimes(1);
  });

  it('prints warnings and errors but not info at warn', () => {
    setVerbosity('warn');
    const s = spyConsole();
    emitAll();
    expect(s.log).not.toHaveBeenCalled();
    expect(s.warn).toHaveBeenCalledTimes(1);
    expect(s.error).toHaveBeenCalledTimes(1);
  });

  it('prints only errors at error', () => {
    setVerbosity('error');
    const s = spyConsole();
    emitAll();
    expect(s.log).not.toHaveBeenCalled();
    expect(s.warn).not.toHaveBeenCalled();
    expect(s.error).toHaveBeenCalledTimes(1);
  });

  it('prints nothing at silent', () => {
    setVerbosity('silent');
    const s = spyConsole();
    emitAll();
    expect(s.log).not.toHaveBeenCalled();
    expect(s.warn).not.toHaveBeenCalled();
    expect(s.error).not.toHaveBeenCalled();
  });

  it("verbosity 'error' suppresses logWarn while logError still prints", () => {
    setVerbosity('error');
    const s = spyConsole();
    logWarn('pkg', 'suppressed');
    logError('pkg', 'shown');
    expect(s.warn).not.toHaveBeenCalled();
    expect(s.error).toHaveBeenCalledTimes(1);
  });
});

describe('build-failing throws ignore the gate', () => {
  const table: RouteTable = {
    'users.show': { name: 'users.show', uri: '/users/{user}', method: 'get', params: [{ name: 'user', optional: false }] },
  };

  it('still throws at silent (the gate never swallows exceptions)', () => {
    setVerbosity('silent');
    // A non-literal route.isCurrent() name is a build-failing error.
    expect(() => transformRoutes(`route.isCurrent(name);`, '/project/src/app.tsx', table)).toThrow(RouteCodemodError);
  });
});

describe('verbosity inherits vite logLevel when unset', () => {
  it("applies vite's logLevel via the config hook so logWarn is gated", () => {
    // Run the config hook against an empty project dir so the generation pass
    // degrades gracefully (no Laravel install), then confirm the level took hold.
    const emptyDir = mkdtempSync(join(tmpdir(), 'ferry-verbosity-'));
    const plugins = ferry({ cwd: emptyDir });
    const main = plugins[0];
    const configHook = main.config as (config: any, env: any) => unknown;

    const s = spyConsole();
    configHook.call({}, { logLevel: 'error' }, { command: 'build', mode: 'production' });

    // Fresh calls after resolution: warn is suppressed, error prints.
    s.warn.mockClear();
    s.error.mockClear();
    logWarn('pkg', 'suppressed');
    logError('pkg', 'shown');
    expect(s.warn).not.toHaveBeenCalled();
    expect(s.error).toHaveBeenCalledTimes(1);
  });
});
