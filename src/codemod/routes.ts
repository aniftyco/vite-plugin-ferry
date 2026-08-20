import MagicString from 'magic-string';
import { parseSync } from 'oxc-parser';
import { pageKeyToTypeName } from '../generators/pages.js';
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

/** Vue template/style sub-requests — the post pass ignores these (bindings are `_ctx.route`). */
const VUE_TEMPLATE_OR_STYLE = /[?&]vue&type=(?:template|style)/;

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
 * and esbuild strips TS. Svelte compiled module, the Vue script sub-request (build), and
 * the Vue main module (dev inlines the script) — never Vue template/style sub-requests.
 */
export function shouldTransformPost(id: string): boolean {
  const clean = id.split('?')[0];
  if (clean.includes('/node_modules/')) return false;
  if (SVELTE_ID.test(id)) return true;
  if (VUE_SCRIPT_SUBREQUEST.test(id)) return true;
  if (VUE_ID.test(clean) && !VUE_TEMPLATE_OR_STYLE.test(id)) return true;
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

/** A `route(...)` call: callee is the bare `route` identifier. */
function isRouteCall(node: Node): boolean {
  return node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'route';
}

/** A `route.isCurrent(...)` call. */
function isIsCurrentCall(node: Node): boolean {
  return (
    node.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    node.callee.object?.type === 'Identifier' &&
    node.callee.object.name === 'route' &&
    node.callee.property?.type === 'Identifier' &&
    node.callee.property.name === 'isCurrent'
  );
}

/** Whether the call carries an explicit `<string>` type argument (`route<string>(...)`). */
function hasStringTypeArg(node: Node): boolean {
  const params = node.typeArguments?.params;
  return Array.isArray(params) && params[0]?.type === 'TSStringKeyword';
}

/** A bare `usePage(...)` call: callee is the `usePage` identifier (Inertia's page hook). */
function isUsePageCall(node: Node): boolean {
  return node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'usePage';
}

/** Whether a call already carries any explicit type argument. */
function hasTypeArgument(node: Node): boolean {
  const params = node.typeArguments?.params;
  return Array.isArray(params) && params.length > 0;
}

/**
 * The props type name for a page-component file, or null when the file is not under a
 * configured `Pages/` root (a shared child component types `usePage` manually). The page
 * key is the path under the root, minus extension: `.../Pages/Users/Show.tsx` → `Users/Show`.
 */
export function pageTypeNameForId(id: string, roots: string[]): string | null {
  const clean = id.split('?')[0];
  for (const root of roots) {
    const prefix = root.endsWith('/') ? root : root + '/';
    if (!clean.startsWith(prefix)) continue;
    const rel = clean.slice(prefix.length).replace(/\.(?:m|c)?[jt]sx?$/, '');
    if (!rel) continue;
    return pageKeyToTypeName(rel);
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
 * The core rewrite, shared by the pre and post passes: rewrites literal `route('name', ...)`
 * and `route.isCurrent(...)` calls so the URI PATTERN (and, for `route()`, the HTTP method)
 * arrive inline, appends `.url` for `route<string>(...)` when the type argument survives (pre
 * pass only — types are stripped by the post pass), and injects the resolver import. The full
 * route table never ships — only referenced routes' patterns end up in the output. Returns
 * `null` when nothing changed. Assumes the id gate + cheap bail already ran.
 *
 * @throws RouteCodemodError on a non-literal route name (protects the no-leak guarantee).
 */
function rewrite(
  code: string,
  id: string,
  table: RouteTable,
  lang: OxcLang,
  pageTypeName: string | null
): { code: string; map: any } | null {
  let parsed;
  try {
    parsed = parseSync(id.split('?')[0], code, { sourceType: 'module', lang });
  } catch {
    return null;
  }

  const s = new MagicString(code);
  let changed = false;
  let usedRoute = false;

  const buildError = (node: Node, message: string): RouteCodemodError => {
    const { line, column } = locate(code, node.start);
    return new RouteCodemodError(`[routes] ${message}\n  at ${id.split('?')[0]}:${line}:${column}`);
  };

  walk(parsed.program, (node) => {
    if (isRouteCall(node)) {
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

      // name literal -> URI pattern, in place
      s.update(nameArg.start, nameArg.end, `'${entry.uri}'`);

      // inject the method so the resolver can return it; keep it at a fixed arg index
      if (args.length === 1) {
        s.appendLeft(nameArg.end, `, undefined, '${entry.method}'`);
      } else {
        s.appendLeft(args[args.length - 1].end, `, '${entry.method}'`);
      }

      // route<string>(...) -> a real string at runtime
      if (hasStringTypeArg(node)) {
        s.appendRight(node.end, '.url');
      }

      changed = true;
      usedRoute = true;
      return;
    }

    if (isIsCurrentCall(node)) {
      const args = node.arguments ?? [];
      const arg = args[0];
      if (!arg) return;

      if (!isStringLiteral(arg)) {
        throw buildError(
          node,
          'route.isCurrent() requires a literal pattern; a non-literal pattern cannot be resolved at build time'
        );
      }

      const value = arg.value;

      if (value.includes('*')) {
        if (value !== '*' && !value.endsWith('.*')) {
          logWarn('routes', `Unsupported wildcard '${value}' (only trailing 'prefix.*' is supported) — emitting false`);
          s.update(node.start, node.end, 'false');
          changed = true;
          return;
        }

        const prefix = value === '*' ? '' : value.slice(0, -2);
        const matched = matchWildcard(table, prefix);
        const patterns = [...new Set(matched.map((name) => table[name].uri))];

        if (patterns.length === 0) {
          logWarn('routes', `Wildcard '${value}' matched no routes (likely a typo) — emitting false`);
          s.update(node.start, node.end, 'false');
          changed = true;
          return;
        }

        if (patterns.length > BROAD_WILDCARD_THRESHOLD) {
          logWarn(
            'routes',
            `Wildcard '${value}' matched ${patterns.length} routes — that many URI patterns ship to the client`
          );
        }

        s.update(arg.start, arg.end, `[${patterns.map((p) => `'${p}'`).join(', ')}]`);
        changed = true;
        usedRoute = true;
        return;
      }

      const entry = table[value];
      if (!entry) {
        logWarn('routes', `Unknown route name '${value}' in route.isCurrent() — leaving call unchanged`);
        return;
      }

      s.update(arg.start, arg.end, `'${entry.uri}'`);
      changed = true;
      usedRoute = true;
      return;
    }

    // usePage() generic injection — PRE pass over a page-component file only. A bare
    // `usePage()` gets the page's props type argument; an already-typed call is left
    // alone. Only survives in real TS source, so it is inherently React/TS-only (the post
    // pass passes no page type and never reaches this).
    if (pageTypeName && isUsePageCall(node) && !hasTypeArgument(node)) {
      s.appendLeft(node.callee.end, `<${pageTypeName}>`);
      changed = true;
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

/** Configurable `Pages/` roots (absolute) the usePage injection resolves page keys against. */
export type PageCodemodOptions = {
  roots: string[];
};

/**
 * PRE pass (`enforce: 'pre'`): rewrites real source modules — React/JSX and plain TS/JS.
 * TS types are intact here, so `route<string>(...)` gets the `.url` sugar and a page
 * component's bare `usePage()` gets its props-type generic injected.
 */
export function transformRoutes(
  code: string,
  id: string,
  table: RouteTable,
  pageOptions?: PageCodemodOptions
): { code: string; map: any } | null {
  if (!shouldTransformPre(id)) return null;
  // Cheap bail: nothing to do if the source never mentions `route` or `usePage`.
  if (!code.includes('route') && !code.includes('usePage')) return null;
  const pageTypeName = pageOptions ? pageTypeNameForId(id, pageOptions.roots) : null;
  return rewrite(code, id, table, deriveLang(id), pageTypeName);
}

/**
 * POST pass (`enforce: 'post'`): rewrites framework-compiled Vue/Svelte modules, after
 * their plugins compile the component and esbuild strips TS. Same rewriting as the pre
 * pass MINUS the `route<string>` → `.url` sugar — there is no `<string>` type argument
 * left to detect at this stage, so that sugar is inherently React/TS-only.
 */
export function transformRoutesPost(code: string, id: string, table: RouteTable): { code: string; map: any } | null {
  if (!shouldTransformPost(id)) return null;
  if (!code.includes('route')) return null;
  // No page type is passed, so the post pass never injects a usePage generic.
  return rewrite(code, id, table, deriveLang(id), null);
}
