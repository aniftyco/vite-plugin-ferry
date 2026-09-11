import pc from 'picocolors';

/**
 * Verbosity levels, ordered by severity. A message prints only when its own
 * severity is at or below the configured threshold, so `silent` suppresses
 * everything, `error` allows only errors, `warn` adds warnings, and `info`
 * (the default) allows everything.
 */
export type Verbosity = 'silent' | 'error' | 'warn' | 'info';

const SEVERITY: Record<Verbosity, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
};

// Module-level threshold. Defaults to `info` so behavior is unchanged until the
// plugin resolves and applies an effective level.
let threshold = SEVERITY.info;

/**
 * Set the active verbosity threshold. Logged output at a higher severity than
 * this level is suppressed. Does not affect thrown exceptions.
 */
export function setVerbosity(level: Verbosity): void {
  threshold = SEVERITY[level];
}

function allowed(level: Verbosity): boolean {
  return SEVERITY[level] <= threshold;
}

/**
 * Log a file change event.
 */
export function logFileChange(packageName: string, fileName: string): void {
  if (!allowed('info')) return;
  const pkgLabel = pc.cyan(`[${packageName}]`);
  const fileLabel = pc.dim(fileName);
  console.log(`${pkgLabel} File changed: ${fileLabel}`);
}

/**
 * Log a regeneration event.
 */
export function logRegeneration(packageName: string): void {
  if (!allowed('info')) return;
  const pkgLabel = pc.cyan(`[${packageName}]`);
  const message = pc.green('✓') + ' Regenerated types';
  console.log(`${pkgLabel} ${message}`);
}

/**
 * Log a warning.
 */
export function logWarn(packageName: string, message: string): void {
  if (!allowed('warn')) return;
  const pkgLabel = pc.yellow(`[${packageName}]`);
  console.warn(`${pkgLabel} ${pc.yellow('⚠')} ${message}`);
}

/**
 * Log an error.
 */
export function logError(packageName: string, message: string, error?: any): void {
  if (!allowed('error')) return;
  const pkgLabel = pc.red(`[${packageName}]`);
  console.error(`${pkgLabel} ${pc.red('✗')} ${message}`);
  if (error) {
    console.error(pc.dim(error.stack || error.message || String(error)));
  }
}
