import { describe, it, expect } from 'vitest';
import { renderKey } from '../src/utils/ts-keys.js';

describe('renderKey', () => {
  it('emits a valid identifier bare', () => {
    expect(renderKey('id')).toBe('id');
    expect(renderKey('created_at')).toBe('created_at');
    expect(renderKey('$ref')).toBe('$ref');
    expect(renderKey('_private')).toBe('_private');
    expect(renderKey('item0')).toBe('item0');
  });

  it('quotes a non-identifier key as a string literal', () => {
    expect(renderKey('display-name')).toBe('"display-name"');
    expect(renderKey('data.value')).toBe('"data.value"');
    expect(renderKey('with space')).toBe('"with space"');
    expect(renderKey('0leading')).toBe('"0leading"');
    expect(renderKey('')).toBe('""');
  });

  it('escapes characters that would break a string literal', () => {
    expect(renderKey('has"quote')).toBe('"has\\"quote"');
  });
});
