/**
 * Source map generation utilities.
 * Implements the Source Map v3 format with VLQ encoding.
 */

export type SourceMapping = {
  generatedLine: number;
  generatedColumn: number;
  sourceLine: number;
  sourceColumn: number;
  name?: string;
};

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Encode a single number as VLQ (Variable Length Quantity).
 */
function encodeVLQ(value: number): string {
  let result = '';
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1;

  do {
    let digit = vlq & 0x1f;
    vlq >>>= 5;
    if (vlq > 0) {
      digit |= 0x20; // continuation bit
    }
    result += BASE64_CHARS[digit];
  } while (vlq > 0);

  return result;
}

/**
 * Encode a source map segment.
 * Each segment contains: generatedColumn, sourceIndex, sourceLine, sourceColumn, [nameIndex]
 */
function encodeSegment(
  generatedColumn: number,
  sourceIndex: number,
  sourceLine: number,
  sourceColumn: number,
  prevState: { genCol: number; srcIdx: number; srcLine: number; srcCol: number }
): string {
  const result =
    encodeVLQ(generatedColumn - prevState.genCol) +
    encodeVLQ(sourceIndex - prevState.srcIdx) +
    encodeVLQ(sourceLine - prevState.srcLine) +
    encodeVLQ(sourceColumn - prevState.srcCol);

  prevState.genCol = generatedColumn;
  prevState.srcIdx = sourceIndex;
  prevState.srcLine = sourceLine;
  prevState.srcCol = sourceColumn;

  return result;
}

/**
 * Generate VLQ-encoded mappings string from mapping entries.
 */
function encodeMappings(mappings: SourceMapping[]): string {
  if (mappings.length === 0) return '';

  // Sort by generated line, then column
  const sorted = [...mappings].sort((a, b) => {
    if (a.generatedLine !== b.generatedLine) return a.generatedLine - b.generatedLine;
    return a.generatedColumn - b.generatedColumn;
  });

  const lines: string[][] = [];
  const state = { genCol: 0, srcIdx: 0, srcLine: 0, srcCol: 0 };

  for (const mapping of sorted) {
    // Ensure we have enough lines
    while (lines.length < mapping.generatedLine) {
      lines.push([]);
      state.genCol = 0; // Reset column at start of each line
    }

    const lineIndex = mapping.generatedLine - 1;
    const segment = encodeSegment(
      mapping.generatedColumn,
      0, // sourceIndex - always 0 since we have one source file per map
      mapping.sourceLine - 1, // 0-indexed in source maps
      mapping.sourceColumn,
      state
    );

    lines[lineIndex].push(segment);
  }

  return lines.map((segments) => segments.join(',')).join(';');
}

export type SourceMapOptions = {
  file: string;
  sourceRoot?: string;
  sources: string[];
  sourcesContent?: (string | null)[];
  names?: string[];
  mappings: SourceMapping[];
};

/**
 * Generate a source map JSON string.
 */
export function generateSourceMap(options: SourceMapOptions): string {
  const { file, sourceRoot = '', sources, sourcesContent, names = [], mappings } = options;

  const map = {
    version: 3,
    file,
    sourceRoot,
    sources,
    ...(sourcesContent ? { sourcesContent } : {}),
    names,
    mappings: encodeMappings(mappings),
  };

  return JSON.stringify(map);
}

/**
 * Create the sourceMappingURL comment to append to generated files.
 */
export function createSourceMapComment(mapFileName: string): string {
  return `//# sourceMappingURL=${mapFileName}`;
}

/**
 * Calculate relative path from one file to another.
 * Used to compute the source path relative to the generated .d.ts.map file.
 */
export function relativePath(from: string, to: string): string {
  const fromParts = from.split('/').slice(0, -1); // Remove filename
  const toParts = to.split('/');

  // Find common prefix
  let commonLength = 0;
  while (
    commonLength < fromParts.length &&
    commonLength < toParts.length &&
    fromParts[commonLength] === toParts[commonLength]
  ) {
    commonLength++;
  }

  // Build relative path
  const ups = fromParts.length - commonLength;
  const remaining = toParts.slice(commonLength);

  return [...Array(ups).fill('..'), ...remaining].join('/');
}
