import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { ROUTE_RUNTIME } from '../src/delivery/route-runtime.js';

type RouteResult = {
  url: string;
  method: string;
  toString(): string;
  [Symbol.toPrimitive](hint: string): string;
};

let route: ((pattern: string, params?: any, method?: string) => RouteResult) & {
  isCurrent(patternOrPatterns: string | string[]): boolean;
};

beforeAll(async () => {
  // The runtime is an ES module string; write it out and import it so it runs for real.
  const dir = mkdtempSync(join(tmpdir(), 'ferry-route-'));
  const file = join(dir, 'route.mjs');
  writeFileSync(file, ROUTE_RUNTIME, 'utf8');
  ({ route } = await import(pathToFileURL(file).href));
});

afterEach(() => {
  delete (globalThis as any).window;
});

describe('route() runtime resolver', () => {
  it('fills a required param', () => {
    expect(route('/users/{user}', { user: 1 }, 'get').url).toBe('/users/1');
  });

  it('url-encodes param values', () => {
    expect(route('/users/{user}', { user: 'a b/c' }, 'get').url).toBe('/users/a%20b%2Fc');
  });

  it('drops an absent optional segment and its slash', () => {
    expect(route('/posts/{post}/comments/{comment?}', { post: 1 }, 'post').url).toBe('/posts/1/comments');
  });

  it('keeps a present optional segment', () => {
    expect(route('/posts/{post}/comments/{comment?}', { post: 1, comment: 9 }, 'post').url).toBe('/posts/1/comments/9');
  });

  it('appends leftover keys as a query string', () => {
    expect(route('/users/{user}', { user: 1, tab: 'a' }, 'get').url).toBe('/users/1?tab=a');
  });

  it('serializes arrays with bracket notation', () => {
    expect(route('/users', { ids: [1, 2] }, 'get').url).toBe('/users?ids%5B%5D=1&ids%5B%5D=2');
  });

  it('skips null and undefined query values', () => {
    expect(route('/users', { a: null, b: undefined, c: 'x' }, 'get').url).toBe('/users?c=x');
  });

  it('carries the injected method', () => {
    expect(route('/users/{user}', { user: 1 }, 'delete').method).toBe('delete');
  });

  it('keeps the root path as a single slash', () => {
    expect(route('/', undefined, 'get').url).toBe('/');
  });

  it('coerces to its url via String() and template literals', () => {
    const result = route('/users/{user}', { user: 1 }, 'get');
    expect(String(result)).toBe('/users/1');
    expect(`${result}`).toBe('/users/1');
    expect('' + result).toBe('/users/1');
  });
});

describe('route.isCurrent() runtime', () => {
  it('returns false during SSR (no window)', () => {
    expect(route.isCurrent('/users/{user}')).toBe(false);
  });

  it('matches the current path against a single pattern', () => {
    (globalThis as any).window = { location: { pathname: '/users/1' } };
    expect(route.isCurrent('/users/{user}')).toBe(true);
    expect(route.isCurrent('/posts/{post}')).toBe(false);
  });

  it('matches against any pattern in an expanded wildcard array', () => {
    (globalThis as any).window = { location: { pathname: '/users' } };
    expect(route.isCurrent(['/users', '/users/{user}'])).toBe(true);
  });

  it('treats an absent optional segment as matching', () => {
    (globalThis as any).window = { location: { pathname: '/posts/1/comments' } };
    expect(route.isCurrent('/posts/{post}/comments/{comment?}')).toBe(true);
  });

  it('does not match a longer path than the pattern', () => {
    (globalThis as any).window = { location: { pathname: '/users/1/edit' } };
    expect(route.isCurrent('/users/{user}')).toBe(false);
  });

  it('matches the concrete param when params are passed', () => {
    (globalThis as any).window = { location: { pathname: '/users/1' } };
    expect(route.isCurrent('/users/{user}', { user: 1 })).toBe(true);
    expect(route.isCurrent('/users/{user}', { user: 2 })).toBe(false);
  });

  it('matches any param when no params are passed', () => {
    (globalThis as any).window = { location: { pathname: '/users/2' } };
    expect(route.isCurrent('/users/{user}')).toBe(true);
    (globalThis as any).window = { location: { pathname: '/users/1' } };
    expect(route.isCurrent('/users/{user}')).toBe(true);
  });

  it('ignores extra (query) keys when comparing the path with params', () => {
    (globalThis as any).window = { location: { pathname: '/users/1' } };
    expect(route.isCurrent('/users/{user}', { user: 1, tab: 'a' })).toBe(true);
  });
});
