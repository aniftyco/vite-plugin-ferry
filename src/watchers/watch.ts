import type { ViteDevServer } from 'vite';

/** A watched-file event ferry regenerates on. */
export type WatchEvent = 'add' | 'change' | 'unlink';

export type FileWatcherConfig = {
  /** Chokidar patterns to watch (absolute). */
  patterns: string[];
  /** Absolute paths of files present at setup, whose initial add-scan must not regenerate. */
  initialFiles: string[];
  /** Whether a reported path belongs to this watcher. */
  owns: (filePath: string) => boolean;
  /** React to a relevant add/change/unlink. */
  onChange: (filePath: string, event: WatchEvent) => void;
};

/**
 * Wire `add`/`change`/`unlink` for a watcher through one regeneration path, so creating or
 * deleting a watched file regenerates output — not only editing one. Guards the initial
 * add-scan: chokidar emits `add` for every file already present when a path is watched, so
 * those initial adds are dropped (tracked by `initialFiles`); only genuinely new files,
 * edits, and deletions regenerate. Shared by all four ferry watchers so they behave the same.
 */
export function setupFileWatcher(server: ViteDevServer, config: FileWatcherConfig): void {
  const { patterns, owns, onChange } = config;
  // Files whose first `add` is the initial scan, not a creation. Deleting one re-arms it so a
  // later recreation is treated as new.
  const initial = new Set(config.initialFiles);

  for (const pattern of patterns) server.watcher.add(pattern);

  server.watcher.on('add', (filePath: string) => {
    if (!owns(filePath)) return;
    if (initial.delete(filePath)) return;
    onChange(filePath, 'add');
  });

  server.watcher.on('change', (filePath: string) => {
    if (!owns(filePath)) return;
    onChange(filePath, 'change');
  });

  server.watcher.on('unlink', (filePath: string) => {
    if (!owns(filePath)) return;
    initial.delete(filePath);
    onChange(filePath, 'unlink');
  });
}
