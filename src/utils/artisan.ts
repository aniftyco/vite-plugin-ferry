import { spawnSync } from 'node:child_process';
import { logError } from './banner.js';

/**
 * Run an artisan command in `cwd` and parse its stdout as JSON. This is ferry's
 * "call out to PHP for truth" primitive, shared by routes (and later resources).
 *
 * Fails gracefully: if PHP/artisan is missing, the command errors, or the output
 * isn't valid JSON, it warns and returns `null` rather than throwing, so a project
 * without a working Laravel install still builds (with empty generated output).
 */
export function runArtisanJson<T = unknown>(cwd: string, args: string[]): T | null {
  const result = spawnSync('php', ['artisan', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    logError('routes', `Failed to run \`php artisan ${args.join(' ')}\``, result.error);
    return null;
  }

  if (result.status !== 0) {
    logError('routes', `\`php artisan ${args.join(' ')}\` exited with code ${result.status}`, result.stderr);
    return null;
  }

  try {
    return JSON.parse(result.stdout) as T;
  } catch (e) {
    logError('routes', `Could not parse JSON from \`php artisan ${args.join(' ')}\``, e);
    return null;
  }
}

/**
 * Run an artisan command in `cwd` and return its raw stdout. Used by the resource
 * metadata dump, which runs `tinker --execute` (not `--json`) and parses sentinel-
 * wrapped output itself. Same graceful degradation as `runArtisanJson`: missing PHP,
 * a nonzero exit, or a spawn error warns and returns `null` rather than throwing.
 */
export function runArtisan(cwd: string, args: string[]): string | null {
  const result = spawnSync('php', ['artisan', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    logError('resources', `Failed to run \`php artisan ${args.join(' ')}\``, result.error);
    return null;
  }

  if (result.status !== 0) {
    logError('resources', `\`php artisan ${args.join(' ')}\` exited with code ${result.status}`, result.stderr);
    return null;
  }

  return result.stdout;
}
