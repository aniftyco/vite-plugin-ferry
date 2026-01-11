import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Safely read a file, returning null if it doesn't exist or can't be read.
 */
export function readFileSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

/**
 * Write a file, ensuring the directory exists.
 */
export function writeFileEnsureDir(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

/**
 * Get all PHP files from a directory.
 */
export function getPhpFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).filter((f) => f.endsWith('.php'));
}

/**
 * Clean generated files from output directory, keeping package.json.
 */
export function cleanOutputDir(outputDir: string): void {
  if (!existsSync(outputDir)) return;

  const files = readdirSync(outputDir);
  for (const file of files) {
    if (file.endsWith('.d.ts') || file.endsWith('.js')) {
      unlinkSync(join(outputDir, file));
    }
  }
}
