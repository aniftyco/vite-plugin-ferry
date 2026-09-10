import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { setupFileWatcher, type WatchEvent } from '../src/watchers/watch.js';
import { setupRouteWatcher } from '../src/watchers/routes.js';
import { createDelivery } from '../src/delivery/index.js';

/** A minimal ViteDevServer stand-in carrying just what the watchers touch. */
function fakeServer(extra: Record<string, unknown> = {}) {
  const watcher = new EventEmitter() as any;
  watcher.add = vi.fn();
  return { watcher, ...extra } as any;
}

describe('setupFileWatcher (item 9: add/change/unlink with initial-scan guard)', () => {
  it('routes add/change/unlink through onChange, dropping the initial add-scan', () => {
    const server = fakeServer();
    const events: Array<[string, WatchEvent]> = [];

    setupFileWatcher(server, {
      patterns: ['/app/*.php'],
      initialFiles: ['/app/a.php'],
      owns: (f) => f.startsWith('/app/'),
      onChange: (f, e) => events.push([f, e]),
    });

    server.watcher.emit('add', '/app/a.php'); // initial scan -> dropped
    server.watcher.emit('add', '/app/b.php'); // genuinely new -> handled
    server.watcher.emit('change', '/app/a.php'); // edit -> handled
    server.watcher.emit('unlink', '/app/b.php'); // delete -> handled
    server.watcher.emit('change', '/other/z.php'); // not owned -> dropped

    expect(events).toEqual([
      ['/app/b.php', 'add'],
      ['/app/a.php', 'change'],
      ['/app/b.php', 'unlink'],
    ]);
  });

  it('re-arms an initial file after deletion so recreating it regenerates', () => {
    const server = fakeServer();
    const events: Array<[string, WatchEvent]> = [];

    setupFileWatcher(server, {
      patterns: [],
      initialFiles: ['/app/a.php'],
      owns: () => true,
      onChange: (f, e) => events.push([f, e]),
    });

    server.watcher.emit('add', '/app/a.php'); // initial -> dropped
    server.watcher.emit('unlink', '/app/a.php'); // delete -> handled, re-arms
    server.watcher.emit('add', '/app/a.php'); // recreated -> now treated as new

    expect(events).toEqual([
      ['/app/a.php', 'unlink'],
      ['/app/a.php', 'add'],
    ]);
  });

  it('registers every watch pattern', () => {
    const server = fakeServer();
    setupFileWatcher(server, { patterns: ['/a/*.php', '/b/**/*.php'], initialFiles: [], owns: () => true, onChange: () => {} });
    expect(server.watcher.add).toHaveBeenCalledWith('/a/*.php');
    expect(server.watcher.add).toHaveBeenCalledWith('/b/**/*.php');
  });
});

describe('setupRouteWatcher (item 10: invalidate module graph before full reload)', () => {
  it('invalidates all cached transforms before sending full-reload', () => {
    const calls: string[] = [];
    const server = fakeServer({
      moduleGraph: {
        invalidateAll: () => calls.push('invalidateAll'),
        getModuleById: () => undefined,
      },
      ws: { send: (msg: { type: string }) => calls.push(`send:${msg.type}`) },
      reloadModule: () => {},
    });

    const cwd = mkdtempSync(join(tmpdir(), 'ferry-routewatch-'));
    const routesDir = join(cwd, 'routes');
    mkdirSync(routesDir, { recursive: true });

    // registerRoutes shells out to `php artisan`; without a Laravel app it degrades to an
    // empty table rather than throwing, which is all this ordering check needs.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setupRouteWatcher({ routesDir, cwd, delivery: createDelivery(cwd), server, onTable: () => {} });
    server.watcher.emit('change', join(routesDir, 'web.php'));
    errSpy.mockRestore();

    expect(calls).toEqual(['invalidateAll', 'send:full-reload']);
  });
});
