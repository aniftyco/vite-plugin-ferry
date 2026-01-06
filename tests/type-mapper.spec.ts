import { describe, it, expect } from 'vitest';
import { mapPhpTypeToTs, mapDocTypeToTs, parseTsObjectStringToPairs } from '../src/utils/type-mapper.js';

describe('mapPhpTypeToTs', () => {
  it('maps integer types to number', () => {
    expect(mapPhpTypeToTs('int')).toBe('number');
    expect(mapPhpTypeToTs('integer')).toBe('number');
    expect(mapPhpTypeToTs('INT')).toBe('number');
  });

  it('maps float types to number', () => {
    expect(mapPhpTypeToTs('float')).toBe('number');
    expect(mapPhpTypeToTs('double')).toBe('number');
    expect(mapPhpTypeToTs('real')).toBe('number');
    expect(mapPhpTypeToTs('decimal')).toBe('number');
  });

  it('maps string type', () => {
    expect(mapPhpTypeToTs('string')).toBe('string');
    expect(mapPhpTypeToTs('STRING')).toBe('string');
  });

  it('maps boolean types', () => {
    expect(mapPhpTypeToTs('bool')).toBe('boolean');
    expect(mapPhpTypeToTs('boolean')).toBe('boolean');
  });

  it('maps array types', () => {
    expect(mapPhpTypeToTs('array')).toBe('any[]');
    expect(mapPhpTypeToTs('json')).toBe('any[]');
  });

  it('maps datetime types to string', () => {
    expect(mapPhpTypeToTs('datetime')).toBe('string');
    expect(mapPhpTypeToTs('date')).toBe('string');
    expect(mapPhpTypeToTs('immutable_datetime')).toBe('string');
    expect(mapPhpTypeToTs('immutable_date')).toBe('string');
  });

  it('returns any for unknown types', () => {
    expect(mapPhpTypeToTs('unknown')).toBe('any');
    expect(mapPhpTypeToTs('custom')).toBe('any');
  });
});

describe('mapDocTypeToTs', () => {
  it('handles nullable types', () => {
    expect(mapDocTypeToTs('?string')).toBe('string | null');
    expect(mapDocTypeToTs('?int')).toBe('number | null');
  });

  it('handles union types', () => {
    expect(mapDocTypeToTs('string|null')).toBe('string | null');
    expect(mapDocTypeToTs('int|string')).toBe('number | string');
  });

  it('handles array notation', () => {
    expect(mapDocTypeToTs('Foo[]')).toBe('Foo[]');
    expect(mapDocTypeToTs('User[]')).toBe('User[]');
  });

  it('handles generic array types', () => {
    expect(mapDocTypeToTs('array<Foo>')).toBe('Foo[]');
    expect(mapDocTypeToTs('array<User>')).toBe('User[]');
  });

  it('handles mixed type', () => {
    expect(mapDocTypeToTs('mixed')).toBe('any');
  });

  it('handles object types', () => {
    expect(mapDocTypeToTs('object')).toBe('Record<string, any>');
    expect(mapDocTypeToTs('stdClass')).toBe('Record<string, any>');
  });

  it('handles array shapes', () => {
    const result = mapDocTypeToTs('array { id: string, name: string }');
    expect(result).toBe('{ id: string; name: string }');
  });

  it('handles nullable array shapes', () => {
    const result = mapDocTypeToTs('?array { id: string }');
    expect(result).toBe('{ id: string } | null');
  });

  it('preserves Record types', () => {
    expect(mapDocTypeToTs('Record<string, any>')).toBe('Record<string, any>');
  });
});

describe('parseTsObjectStringToPairs', () => {
  it('parses simple object string', () => {
    const result = parseTsObjectStringToPairs('{ id: string; name: string }');
    expect(result).toEqual({ id: 'string', name: 'string' });
  });

  it('parses object with optional fields', () => {
    const result = parseTsObjectStringToPairs('{ id: string; name?: string }');
    expect(result).toEqual({ id: 'string', name: 'string' });
  });

  it('parses object with complex types', () => {
    const result = parseTsObjectStringToPairs('{ items: User[]; meta: { total: number } }');
    expect(result).toEqual({
      items: 'User[]',
      meta: '{ total: number }',
    });
  });

  it('returns empty object for invalid input', () => {
    expect(parseTsObjectStringToPairs('not an object')).toEqual({});
    expect(parseTsObjectStringToPairs('')).toEqual({});
  });

  it('handles comma separators', () => {
    const result = parseTsObjectStringToPairs('{ id: string, name: string }');
    expect(result).toEqual({ id: 'string', name: 'string' });
  });
});
