import { describe, it, expect } from 'vitest';
import {
  generateSourceMap,
  createSourceMapComment,
  relativePath,
  type SourceMapping,
} from '../src/utils/source-map.js';

describe('createSourceMapComment', () => {
  it('creates correct sourceMappingURL comment', () => {
    expect(createSourceMapComment('index.d.ts.map')).toBe('//# sourceMappingURL=index.d.ts.map');
  });

  it('handles nested paths', () => {
    expect(createSourceMapComment('types/User.d.ts.map')).toBe('//# sourceMappingURL=types/User.d.ts.map');
  });
});

describe('relativePath', () => {
  it('calculates relative path between files', () => {
    expect(relativePath('node_modules/@ferry/resources/User.d.ts', 'app/Http/Resources/User.php'))
      .toBe('../../../app/Http/Resources/User.php');
  });

  it('handles same directory', () => {
    expect(relativePath('src/a.ts', 'src/b.ts')).toBe('b.ts');
  });

  it('handles parent directory', () => {
    expect(relativePath('src/sub/a.ts', 'src/b.ts')).toBe('../b.ts');
  });
});

describe('generateSourceMap', () => {
  it('generates valid source map JSON', () => {
    const mappings: SourceMapping[] = [
      { generatedLine: 1, generatedColumn: 0, sourceLine: 5, sourceColumn: 0 },
    ];

    const result = generateSourceMap({
      file: 'User.d.ts',
      sources: ['../../../app/Http/Resources/User.php'],
      mappings,
    });

    const parsed = JSON.parse(result);

    expect(parsed.version).toBe(3);
    expect(parsed.file).toBe('User.d.ts');
    expect(parsed.sources).toEqual(['../../../app/Http/Resources/User.php']);
    expect(parsed.names).toEqual([]);
    expect(typeof parsed.mappings).toBe('string');
  });

  it('generates empty mappings string for no mappings', () => {
    const result = generateSourceMap({
      file: 'Empty.d.ts',
      sources: ['Empty.php'],
      mappings: [],
    });

    const parsed = JSON.parse(result);
    expect(parsed.mappings).toBe('');
  });

  it('includes sourceRoot when provided', () => {
    const result = generateSourceMap({
      file: 'User.d.ts',
      sourceRoot: '/project/',
      sources: ['app/User.php'],
      mappings: [],
    });

    const parsed = JSON.parse(result);
    expect(parsed.sourceRoot).toBe('/project/');
  });

  it('includes sourcesContent when provided', () => {
    const result = generateSourceMap({
      file: 'User.d.ts',
      sources: ['User.php'],
      sourcesContent: ['<?php class User {}'],
      mappings: [],
    });

    const parsed = JSON.parse(result);
    expect(parsed.sourcesContent).toEqual(['<?php class User {}']);
  });

  it('generates VLQ-encoded mappings for single mapping', () => {
    const mappings: SourceMapping[] = [
      { generatedLine: 1, generatedColumn: 0, sourceLine: 1, sourceColumn: 0 },
    ];

    const result = generateSourceMap({
      file: 'test.d.ts',
      sources: ['test.php'],
      mappings,
    });

    const parsed = JSON.parse(result);
    // First mapping at line 1, col 0, source 0, line 0, col 0 = AAAA
    expect(parsed.mappings).toBe('AAAA');
  });

  it('generates correct mappings for multiple lines', () => {
    const mappings: SourceMapping[] = [
      { generatedLine: 1, generatedColumn: 0, sourceLine: 1, sourceColumn: 0 },
      { generatedLine: 2, generatedColumn: 0, sourceLine: 2, sourceColumn: 0 },
      { generatedLine: 3, generatedColumn: 0, sourceLine: 3, sourceColumn: 0 },
    ];

    const result = generateSourceMap({
      file: 'test.d.ts',
      sources: ['test.php'],
      mappings,
    });

    const parsed = JSON.parse(result);
    // Each line separated by semicolons
    expect(parsed.mappings.split(';').length).toBe(3);
  });

  it('handles multiple mappings on same line', () => {
    const mappings: SourceMapping[] = [
      { generatedLine: 1, generatedColumn: 0, sourceLine: 1, sourceColumn: 0 },
      { generatedLine: 1, generatedColumn: 10, sourceLine: 1, sourceColumn: 5 },
    ];

    const result = generateSourceMap({
      file: 'test.d.ts',
      sources: ['test.php'],
      mappings,
    });

    const parsed = JSON.parse(result);
    // Two segments on same line separated by comma
    expect(parsed.mappings.includes(',')).toBe(true);
  });

  it('handles non-sequential line numbers', () => {
    const mappings: SourceMapping[] = [
      { generatedLine: 2, generatedColumn: 0, sourceLine: 10, sourceColumn: 0 },
      { generatedLine: 5, generatedColumn: 4, sourceLine: 15, sourceColumn: 2 },
    ];

    const result = generateSourceMap({
      file: 'test.d.ts',
      sources: ['test.php'],
      mappings,
    });

    const parsed = JSON.parse(result);
    // Should have empty lines represented by just semicolons
    const lines = parsed.mappings.split(';');
    expect(lines.length).toBe(5);
    expect(lines[0]).toBe(''); // line 1 empty
    expect(lines[1]).not.toBe(''); // line 2 has mapping
    expect(lines[2]).toBe(''); // line 3 empty
    expect(lines[3]).toBe(''); // line 4 empty
    expect(lines[4]).not.toBe(''); // line 5 has mapping
  });

  it('sorts mappings by line and column', () => {
    // Provide mappings out of order
    const mappings: SourceMapping[] = [
      { generatedLine: 2, generatedColumn: 0, sourceLine: 2, sourceColumn: 0 },
      { generatedLine: 1, generatedColumn: 0, sourceLine: 1, sourceColumn: 0 },
    ];

    const result = generateSourceMap({
      file: 'test.d.ts',
      sources: ['test.php'],
      mappings,
    });

    const parsed = JSON.parse(result);
    // Should still produce valid output with line 1 first
    const lines = parsed.mappings.split(';');
    expect(lines.length).toBe(2);
    expect(lines[0]).not.toBe('');
    expect(lines[1]).not.toBe('');
  });
});

describe('VLQ encoding', () => {
  it('encodes zero correctly', () => {
    const mappings: SourceMapping[] = [
      { generatedLine: 1, generatedColumn: 0, sourceLine: 1, sourceColumn: 0 },
    ];

    const result = generateSourceMap({
      file: 'test.d.ts',
      sources: ['test.php'],
      mappings,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mappings).toBe('AAAA');
  });

  it('encodes small positive numbers correctly', () => {
    const mappings: SourceMapping[] = [
      { generatedLine: 1, generatedColumn: 1, sourceLine: 1, sourceColumn: 0 },
    ];

    const result = generateSourceMap({
      file: 'test.d.ts',
      sources: ['test.php'],
      mappings,
    });

    const parsed = JSON.parse(result);
    // Column 1 encodes as 'C' (1 << 1 = 2, base64[2] = 'C')
    expect(parsed.mappings).toBe('CAAA');
  });

  it('encodes larger numbers with continuation bits', () => {
    const mappings: SourceMapping[] = [
      { generatedLine: 1, generatedColumn: 100, sourceLine: 1, sourceColumn: 0 },
    ];

    const result = generateSourceMap({
      file: 'test.d.ts',
      sources: ['test.php'],
      mappings,
    });

    const parsed = JSON.parse(result);
    // 100 requires continuation bit
    expect(parsed.mappings.length).toBeGreaterThan(4);
  });
});
