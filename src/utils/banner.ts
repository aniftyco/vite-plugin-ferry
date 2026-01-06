import pc from 'picocolors';

/**
 * Display a startup banner for the plugin.
 */
export function displayBanner(options: { packages: string[]; version?: string }): void {
  const { packages, version = '1.0.0' } = options;

  console.log('');
  console.log(pc.cyan('  PRIMCLOUD') + pc.dim(` resource-types ${pc.bold(`v${version}`)}`));
  console.log('');

  for (const pkg of packages) {
    console.log(pc.green('  ➜') + '  ' + pc.bold(pkg));
  }

  console.log('');
}

/**
 * Log a file change event.
 */
export function logFileChange(packageName: string, fileName: string): void {
  const pkgLabel = pc.cyan(`[${packageName}]`);
  const fileLabel = pc.dim(fileName);
  console.log(`${pkgLabel} File changed: ${fileLabel}`);
}

/**
 * Log a regeneration event.
 */
export function logRegeneration(packageName: string): void {
  const pkgLabel = pc.cyan(`[${packageName}]`);
  const message = pc.green('✓') + ' Regenerated types';
  console.log(`${pkgLabel} ${message}`);
}

/**
 * Log an error.
 */
export function logError(packageName: string, message: string, error?: any): void {
  const pkgLabel = pc.red(`[${packageName}]`);
  console.error(`${pkgLabel} ${pc.red('✗')} ${message}`);
  if (error) {
    console.error(pc.dim(error.stack || error.message || String(error)));
  }
}
