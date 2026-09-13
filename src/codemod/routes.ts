import MagicString from 'magic-string';
import { parseSync } from 'oxc-parser';
import type { RouteTable } from '../generators/routes.js';
import { ROUTE_MODULE_ID } from '../generators/routes.js';
import { logWarn } from '../utils/banner.js';

/** Real source files the PRE pass owns (React/JSX + plain TS/JS). `.d.ts` excluded below. */
const PRE_TRANSFORMABLE = /\.(?:m|c)?[jt]sx?$/;

/** A Svelte module id (the compiled JS module, script + markup). */
const SVELTE_ID = /\.svelte(?:$|\?)/;

/** A Vue module id: the main module or any `?vue&...` sub-request. */
const VUE_ID = /\.vue(?:$|\?)/;

/** A Vue `?vue&...` sub-request query (any type). */
const VUE_QUERY = /[?&]vue&/;

/** A Vue `?vue&type=style` sub-request — pure CSS, so the post pass skips it. */
const VUE_STYLE = /[?&]vue&type=style/;

/** The Vue script sub-request (build emits the script here, already-stripped JS). */
const VUE_SCRIPT_SUBREQUEST = /[?&]vue&type=script\b/;

/** A wildcard matching more than this many routes warns (ships many patterns). */
const BROAD_WILDCARD_THRESHOLD = 25;

/** The oxc `lang` values (`ParserOptions.lang`). */
export type OxcLang = 'js' | 'jsx' | 'ts' | 'tsx' | 'dts';

/** Thrown for a non-literal route name — a build error that protects the no-leak guarantee. */
export class RouteCodemodError extends Error {}

/**
 * PRE pass ownership: real source modules (React/JSX + plain TS/JS). Framework-compiled
 * requests (Vue `.vue`/`?vue&`, Svelte `.svelte`) are explicitly excluded so they are
 * handled ONLY by the post pass — consistently in dev and build. Ownership is mutually
 * exclusive with `shouldTransformPost`.
 */
export function shouldTransformPre(id: string): boolean {
  const clean = id.split('?')[0];
  if (clean.includes('/node_modules/')) return false;
  if (clean.endsWith('.d.ts')) return false;
  if (VUE_ID.test(clean) || VUE_QUERY.test(id) || SVELTE_ID.test(id)) return false;
  return PRE_TRANSFORMABLE.test(clean);
}

/**
 * POST pass ownership: framework-compiled modules, after plugin-vue/plugin-svelte compile
 * and esbuild strips TS. The Svelte compiled module (bare `route(...)`), the Vue script
 * sub-request (build), the Vue template sub-request (build — compiled to `_ctx.route(...)`),
 * and the Vue main module (dev inlines template + script). Only Vue style sub-requests,
 * which are pure CSS, are skipped.
 */
export function shouldTransformPost(id: string): boolean {
  const clean = id.split('?')[0];
  if (clean.includes('/node_modules/')) return false;
  if (SVELTE_ID.test(id)) return true;
  if (VUE_SCRIPT_SUBREQUEST.test(id)) return true;
  if (VUE_ID.test(clean) && !VUE_STYLE.test(id)) return true;
  return false;
}

/**
 * The oxc parse `lang` for an id: from the `&lang.<ext>` query token Vue/Svelte append,
 * falling back to the file extension. Passed explicitly so a `Foo.vue?...&lang.ts`
 * sub-request parses as TS (oxc would otherwise not recognize `.vue`).
 */
export function deriveLang(id: string): OxcLang {
  const qIndex = id.indexOf('?');
  const query = qIndex >= 0 ? id.slice(qIndex) : '';
  const token = query.match(/[?&]lang\.(tsx|ts|jsx|js)\b/);
  if (token) return token[1] as OxcLang;

  const clean = qIndex >= 0 ? id.slice(0, qIndex) : id;
  if (clean.endsWith('.tsx')) return 'tsx';
  if (/\.(?:m|c)?ts$/.test(clean)) return 'ts';
  if (clean.endsWith('.jsx')) return 'jsx';
  return 'js';
}

/** 1-based line/column for an offset, for readable build-error locations. */
function locate(code: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const end = Math.min(offset, code.length);
  for (let i = 0; i < end; i++) {
    if (code[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

type Node = any;

/** Depth-first walk over the oxc TS-ESTree AST, visiting every node with a `type`. */
function walk(node: Node, visit: (node: Node) => void): void {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else if (value && typeof value === 'object') {
      walk(value, visit);
    }
  }
}

function isStringLiteral(node: Node): node is { value: string; start: number; end: number } {
  return node && node.type === 'Literal' && typeof node.value === 'string';
}

/** A non-computed `Identifier`-named property access, e.g. `.route` in `_ctx.route`. */
function isNamedMember(node: Node, name: string): boolean {
  return (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.property?.type === 'Identifier' &&
    node.property.name === name
  );
}

/**
 * A `route(...)` resolver call. Matches the bare `route(...)` identifier AND the Vue
 * compiled-template form `_ctx.route(...)` (an unqualified `route` in a `<template>` compiles
 * to a `_ctx` member access). Returns the callee span to normalize to the bare `route`
 * identifier, plus whether that normalization is needed. Returns null for anything else.
 */
function routeCallee(node: Node): { start: number; end: number; normalize: boolean } | null {
  if (node.type !== 'CallExpression') return null;
  const callee = node.callee;
  if (callee?.type === 'Identifier' && callee.name === 'route') {
    return { start: callee.start, end: callee.end, normalize: false };
  }
  // `_ctx.route(...)` — Vue's compiled binding for an unqualified `route`.
  if (isNamedMember(callee, 'route') && callee.object?.type === 'Identifier' && callee.object.name === '_ctx') {
    return { start: callee.start, end: callee.end, normalize: true };
  }
  return null;
}

/**
 * A `route.is(...)` call. Matches the bare `route.is(...)` AND the Vue compiled-template
 * form `_ctx.route.is(...)`. Returns the span of the `route` receiver to normalize to the
 * bare `route` identifier, plus whether that normalization is needed.
 */
function isCallee(node: Node): { start: number; end: number; normalize: boolean } | null {
  if (node.type !== 'CallExpression' || !isNamedMember(node.callee, 'is')) return null;
  const obj = node.callee.object;
  if (obj?.type === 'Identifier' && obj.name === 'route') {
    return { start: obj.start, end: obj.end, normalize: false };
  }
  // `_ctx.route.is(...)` — Vue's compiled binding.
  if (isNamedMember(obj, 'route') && obj.object?.type === 'Identifier' && obj.object.name === '_ctx') {
    return { start: obj.start, end: obj.end, normalize: true };
  }
  return null;
}

/** Route names matched by a wildcard: `users.*` → names under `users.`; `*` → all. */
function matchWildcard(table: RouteTable, prefix: string): string[] {
  const names = Object.keys(table);
  if (prefix === '') return names.sort();
  return names.filter((name) => name.startsWith(prefix + '.')).sort();
}

/**
 * Resolve a single `route.is` operand — a route name or a `prefix.*` / `*` wildcard — to its
 * URI pattern(s). A name yields its one URI; a wildcard yields every matched route's URI. The
 * flags let callers warn/skip: `unsupported` for a non-trailing wildcard, `unknown` for a
 * name or wildcard that matched nothing.
 */
function resolvePatterns(
  table: RouteTable,
  value: string
): { patterns: string[]; unsupported?: boolean; unknown?: boolean } {
  if (value.includes('*')) {
    if (value !== '*' && !value.endsWith('.*')) return { patterns: [], unsupported: true };
    const prefix = value === '*' ? '' : value.slice(0, -2);
    const patterns = [...new Set(matchWildcard(table, prefix).map((name) => table[name].uri))];
    if (patterns.length === 0) return { patterns: [], unknown: true };
    return { patterns };
  }
  const entry = table[value];
  if (!entry) return { patterns: [], unknown: true };
  return { patterns: [entry.uri] };
}

/**
 * The core rewrite, shared by the pre and post passes: rewrites literal `route('name', ...)`
 * and `route.is(...)` calls so the URI PATTERN (and, for `route()`, the HTTP method)
 * arrive inline, and injects the resolver import. Vue's compiled `_ctx.route(...)` /
 * `_ctx.route.is(...)` bindings are normalized to the imported `route` so they resolve
 * through ferry too. The full route table never ships — only referenced routes' patterns end
 * up in the output. Returns `null` when nothing changed. Assumes the id gate + cheap bail
 * already ran.
 *
 * @throws RouteCodemodError on a non-literal route name (protects the no-leak guarantee).
 */
function rewrite(code: string, id: string, table: RouteTable, lang: OxcLang): { code: string; map: any } | null {
  let parsed;
  try {
    parsed = parseSync(id.split('?')[0], code, { sourceType: 'module', lang });
  } catch {
    return null;
  }

  const s = new MagicString(code);
  let changed = false;
  let usedRoute = false;

  // An empty table means `php artisan route:list` returned nothing (e.g. PHP unavailable in the
  // build environment). Any `route()`/`route.is()` usage would then ship referencing an undefined
  // `route`, so we fail the build loudly instead of degrading silently.
  const tableEmpty = Object.keys(table).length === 0;

  const buildError = (node: Node, message: string): RouteCodemodError => {
    const { line, column } = locate(code, node.start);
    return new RouteCodemodError(`[routes] ${message}\n  at ${id.split('?')[0]}:${line}:${column}`);
  };

  const emptyTableError = (node: Node): RouteCodemodError =>
    buildError(
      node,
      "route() is used but no routes were loaded — 'php artisan route:list' returned nothing. PHP (and your Laravel app) must be available in the environment that builds the frontend."
    );

  walk(parsed.program, (node) => {
    const routeCall = routeCallee(node);
    if (routeCall) {
      if (tableEmpty) throw emptyTableError(node);
      const args = node.arguments ?? [];
      const nameArg = args[0];
      if (!nameArg) return;

      if (!isStringLiteral(nameArg)) {
        throw buildError(
          node,
          'route() requires a literal route name; a non-literal name cannot be resolved at build time'
        );
      }

      const entry = table[nameArg.value];
      if (!entry) {
        logWarn('routes', `Unknown route name '${nameArg.value}' in ${id.split('?')[0]} — leaving call unchanged`);
        return;
      }

      // `_ctx.route` -> the imported `route`, so the injected resolver is the one called.
      if (routeCall.normalize) {
        s.update(routeCall.start, routeCall.end, 'route');
      }

      // name literal -> URI pattern, in place
      s.update(nameArg.start, nameArg.end, `'${entry.uri}'`);

      // inject the method so the resolver can return it; keep it at a fixed arg index
      if (args.length === 1) {
        s.appendLeft(nameArg.end, `, undefined, '${entry.method}'`);
      } else {
        s.appendLeft(args[args.length - 1].end, `, '${entry.method}'`);
      }

      changed = true;
      usedRoute = true;
      return;
    }

    const is = isCallee(node);
    if (is) {
      if (tableEmpty) throw emptyTableError(node);
      const args = node.arguments ?? [];
      const arg = args[0];
      if (!arg) return;

      // Array form: `route.is(['users.show', 'admin.*'])` — resolve every element to its URI
      // pattern(s) and flatten to one array. A bad element is skipped (warned), not fatal.
      if (arg.type === 'ArrayExpression') {
        const patterns: string[] = [];
        for (const el of arg.elements ?? []) {
          if (!isStringLiteral(el)) {
            throw buildError(
              node,
              'route.is() requires literal route names/patterns; a non-literal cannot be resolved at build time'
            );
          }
          const resolved = resolvePatterns(table, el.value);
          if (resolved.unsupported) {
            logWarn('routes', `Unsupported wildcard '${el.value}' (only trailing 'prefix.*' is supported) — skipping`);
          } else if (resolved.unknown) {
            logWarn('routes', `Unknown route name/wildcard '${el.value}' in route.is() — skipping`);
          }
          patterns.push(...resolved.patterns);
        }

        // `_ctx.route.is` -> `route.is`, so the injected resolver is used.
        if (is.normalize) {
          s.update(is.start, is.end, 'route');
        }

        const unique = [...new Set(patterns)];
        if (unique.length === 0) {
          logWarn('routes', `route.is([...]) matched no routes (likely a typo) — emitting false`);
          s.update(node.start, node.end, 'false');
          changed = true;
          return;
        }

        if (unique.length > BROAD_WILDCARD_THRESHOLD) {
          logWarn(
            'routes',
            `route.is([...]) matched ${unique.length} routes — that many URI patterns ship to the client`
          );
        }

        s.update(arg.start, arg.end, `[${unique.map((p) => `'${p}'`).join(', ')}]`);
        changed = true;
        usedRoute = true;
        return;
      }

      if (!isStringLiteral(arg)) {
        throw buildError(
          node,
          'route.is() requires a literal pattern; a non-literal pattern cannot be resolved at build time'
        );
      }

      // `_ctx.route.is` -> `route.is`, so the injected resolver is used.
      if (is.normalize) {
        s.update(is.start, is.end, 'route');
      }

      const value = arg.value;
      const resolved = resolvePatterns(table, value);

      if (resolved.unsupported) {
        logWarn('routes', `Unsupported wildcard '${value}' (only trailing 'prefix.*' is supported) — emitting false`);
        s.update(node.start, node.end, 'false');
        changed = true;
        return;
      }

      if (resolved.unknown) {
        // A bare wildcard that matched nothing is a likely typo -> false; a bare name that is
        // unknown is left unchanged (it may be resolved by another tool).
        if (value.includes('*')) {
          logWarn('routes', `Wildcard '${value}' matched no routes (likely a typo) — emitting false`);
          s.update(node.start, node.end, 'false');
          changed = true;
        } else {
          logWarn('routes', `Unknown route name '${value}' in route.is() — leaving call unchanged`);
        }
        return;
      }

      // A wildcard resolves to an array of patterns; a single name to its one URI string.
      if (value.includes('*')) {
        if (resolved.patterns.length > BROAD_WILDCARD_THRESHOLD) {
          logWarn(
            'routes',
            `Wildcard '${value}' matched ${resolved.patterns.length} routes — that many URI patterns ship to the client`
          );
        }
        s.update(arg.start, arg.end, `[${resolved.patterns.map((p) => `'${p}'`).join(', ')}]`);
      } else {
        s.update(arg.start, arg.end, `'${resolved.patterns[0]}'`);
      }
      changed = true;
      usedRoute = true;
      return;
    }
  });

  // Inject the resolver import once per module that references the global `route`.
  if (usedRoute && !code.includes(`'${ROUTE_MODULE_ID}'`) && !code.includes(`"${ROUTE_MODULE_ID}"`)) {
    s.prepend(`import { route } from '${ROUTE_MODULE_ID}';\n`);
    changed = true;
  }

  if (!changed) return null;

  return {
    code: s.toString(),
    map: s.generateMap({ source: id, hires: true }),
  };
}

/**
 * PRE pass (`enforce: 'pre'`): rewrites real source modules — React/JSX and plain TS/JS.
 */
export function transformRoutes(code: string, id: string, table: RouteTable): { code: string; map: any } | null {
  if (!shouldTransformPre(id)) return null;
  // Cheap bail: nothing to do if the source never mentions `route`.
  if (!code.includes('route')) return null;
  return rewrite(code, id, table, deriveLang(id));
}

/**
 * POST pass (`enforce: 'post'`): rewrites framework-compiled Vue/Svelte modules, after
 * their plugins compile the component and esbuild strips TS.
 */
export function transformRoutesPost(code: string, id: string, table: RouteTable): { code: string; map: any } | null {
  if (!shouldTransformPost(id)) return null;
  if (!code.includes('route')) return null;
  return rewrite(code, id, table, deriveLang(id));
}
