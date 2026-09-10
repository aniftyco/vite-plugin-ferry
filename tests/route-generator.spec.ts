import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  buildRouteTable,
  normalizeMethod,
  normalizeUri,
  extractParams,
  wildcardPrefixes,
  generateRoutesDts,
  type RouteTable,
} from '../src/generators/routes.js';
import { dedent } from './utils.js';

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'route-list.json'), 'utf8'));

describe('normalizeMethod', () => {
  it('drops HEAD and lowercases the primary method', () => {
    expect(normalizeMethod('GET|HEAD')).toBe('get');
  });

  it('keeps DELETE, POST, PUT, PATCH', () => {
    expect(normalizeMethod('DELETE')).toBe('delete');
    expect(normalizeMethod('POST')).toBe('post');
    expect(normalizeMethod('PUT|PATCH')).toBe('put');
  });

  it('skips OPTIONS and falls back to get when nothing usable remains', () => {
    expect(normalizeMethod('HEAD|OPTIONS')).toBe('get');
    expect(normalizeMethod('')).toBe('get');
    expect(normalizeMethod(null)).toBe('get');
  });
});

describe('normalizeUri', () => {
  it('adds a leading slash', () => {
    expect(normalizeUri('users/{user}')).toBe('/users/{user}');
  });

  it('keeps the root as a single slash', () => {
    expect(normalizeUri('/')).toBe('/');
    expect(normalizeUri('')).toBe('/');
  });

  it('collapses an existing leading slash', () => {
    expect(normalizeUri('/users')).toBe('/users');
  });
});

describe('extractParams', () => {
  it('extracts required and optional params in order', () => {
    expect(extractParams('/posts/{post}/comments/{comment?}')).toEqual([
      { name: 'post', optional: false },
      { name: 'comment', optional: true },
    ]);
  });

  it('returns empty for a paramless uri', () => {
    expect(extractParams('/users')).toEqual([]);
  });
});

describe('buildRouteTable', () => {
  it('builds entries for named routes only', () => {
    const table = buildRouteTable(fixture);

    expect(Object.keys(table).sort()).toEqual([
      'admin.users.show',
      'home',
      'posts.comments.store',
      'users.destroy',
      'users.index',
      'users.show',
    ]);
  });

  it('resolves uri, method, and params per route', () => {
    const table = buildRouteTable(fixture);

    expect(table['users.show']).toEqual({
      name: 'users.show',
      uri: '/users/{user}',
      method: 'get',
      params: [{ name: 'user', optional: false }],
    });
    expect(table['users.destroy'].method).toBe('delete');
    expect(table['posts.comments.store'].params).toEqual([
      { name: 'post', optional: false },
      { name: 'comment', optional: true },
    ]);
  });
});

describe('wildcardPrefixes', () => {
  it('emits every segment-boundary prefix, deduped and sorted', () => {
    expect(wildcardPrefixes(['users.show', 'users.index', 'admin.users.show', 'home'])).toEqual([
      'admin.*',
      'admin.users.*',
      'users.*',
    ]);
  });

  it('contributes nothing for single-segment names', () => {
    expect(wildcardPrefixes(['home', 'dashboard'])).toEqual([]);
  });
});

describe('generateRoutesDts', () => {
  const table: RouteTable = {
    'users.index': { name: 'users.index', uri: '/users', method: 'get', params: [] },
    'users.show': { name: 'users.show', uri: '/users/{user}', method: 'get', params: [{ name: 'user', optional: false }] },
    'posts.comments.store': {
      name: 'posts.comments.store',
      uri: '/posts/{post}/comments/{comment?}',
      method: 'post',
      params: [
        { name: 'post', optional: false },
        { name: 'comment', optional: true },
      ],
    },
  };

  it('emits the FerryRoutes interface with required and optional params', () => {
    const dts = generateRoutesDts(table);

    expect(dts).toContain(`  'users.index': {};`);
    expect(dts).toContain(`  'users.show': { user: string | number };`);
    expect(dts).toContain(`  'posts.comments.store': { post: string | number; comment?: string | number };`);
  });

  it('emits the wildcard union from real route-name prefixes', () => {
    const dts = generateRoutesDts(table);

    expect(dts).toContain(`type FerryRouteWildcard =`);
    expect(dts).toContain(`  | 'posts.*'`);
    expect(dts).toContain(`  | 'users.*'`);
    expect(dts).not.toContain(`'home.*'`);
  });

  it('emits the static helper types and the route function/namespace', () => {
    const dts = generateRoutesDts(table);

    expect(dts).toContain(`type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';`);
    expect(dts).toContain(`type QueryBag = Record<string, QueryValue>;`);
    expect(dts).toContain(`[Symbol.toPrimitive](hint: string): string;`);
    expect(dts).toContain(`declare function route<`);
    expect(dts).toContain(`declare namespace route {`);
    expect(dts).toContain(`function isCurrent<K extends keyof FerryRoutes>(name: K, params?: FerryRoutes[K]): boolean;`);
  });

  it('is script-style: zero top-level import/export', () => {
    const dts = generateRoutesDts(table);
    const topLevel = dts.split('\n').filter((line) => /^(import|export)\b/.test(line));
    expect(topLevel).toEqual([]);
  });

  it('emits an empty interface and a never wildcard for zero routes', () => {
    const dts = generateRoutesDts({});

    expect(dts).toContain(`interface FerryRoutes {}`);
    expect(dts).toContain(`type FerryRouteWildcard = never;`);
  });
});
