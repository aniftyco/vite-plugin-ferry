import type { Delivery } from '../delivery/index.js';
import { ROUTE_RUNTIME } from '../delivery/route-runtime.js';
import { runArtisanJson } from '../utils/artisan.js';

/** The ferry virtual/type module id the route resolver is delivered under. */
export const ROUTE_MODULE_ID = '@ferry/route';

/** A single HTTP method, lowercased, as it drops into Inertia's router / form.submit. */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** A route URI parameter: its name and whether the URI segment is optional (`{user?}`). */
export type RouteParam = {
  name: string;
  optional: boolean;
};

/** A resolved route: its URI pattern, primary method, and URI parameters. */
export type RouteEntry = {
  name: string;
  uri: string;
  method: HttpMethod;
  params: RouteParam[];
};

/** The route table: route name → its resolved entry. */
export type RouteTable = Record<string, RouteEntry>;

/** The shape of one entry in `php artisan route:list --json` output. */
type ArtisanRoute = {
  domain?: string | null;
  method?: string | null;
  uri?: string | null;
  name?: string | null;
};

export type RouteRegisterOptions = {
  cwd: string;
  delivery: Delivery;
};

const KNOWN_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

/**
 * Normalize `route:list`'s method field (uppercase, often `GET|HEAD`) to a single
 * lowercase primary method, dropping `HEAD`/`OPTIONS`. Falls back to `get`.
 */
export function normalizeMethod(method: string | null | undefined): HttpMethod {
  const candidates = (method ?? '')
    .split('|')
    .map((m) => m.trim().toLowerCase())
    .filter((m) => m !== 'head' && m !== 'options');

  for (const candidate of candidates) {
    if ((KNOWN_METHODS as string[]).includes(candidate)) {
      return candidate as HttpMethod;
    }
  }

  return 'get';
}

/** Normalize a Laravel URI (`users/{user}`, `/`) to a leading-slash pattern (`/users/{user}`). */
export function normalizeUri(uri: string | null | undefined): string {
  const raw = (uri ?? '').trim();
  if (raw === '' || raw === '/') return '/';
  const withoutLeading = raw.replace(/^\/+/, '');
  return '/' + withoutLeading;
}

/** Extract URI parameters (`{user}`, `{user?}`) in order, marking optional segments. */
export function extractParams(uri: string): RouteParam[] {
  const params: RouteParam[] = [];
  const re = /\{(\w+)(\?)?\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(uri)) !== null) {
    params.push({ name: match[1], optional: match[2] === '?' });
  }
  return params;
}

/**
 * Build the route table from parsed `route:list --json` output. Unnamed routes are
 * skipped (only named routes are addressable through `route()`).
 */
export function buildRouteTable(routes: ArtisanRoute[]): RouteTable {
  const table: RouteTable = {};

  for (const route of routes) {
    const name = route.name;
    if (!name) continue;

    const uri = normalizeUri(route.uri);
    table[name] = {
      name,
      uri,
      method: normalizeMethod(route.method),
      params: extractParams(uri),
    };
  }

  return table;
}

/**
 * Spawn `php artisan route:list --json` and build the route table. Degrades to an
 * empty table (with a warning) when artisan is unavailable or fails.
 */
export function collectRoutes(cwd: string): RouteTable {
  const json = runArtisanJson<ArtisanRoute[]>(cwd, ['route:list', '--json']);
  if (!json || !Array.isArray(json)) return {};
  return buildRouteTable(json);
}

/** Route names sorted for deterministic output. */
function sortedNames(table: RouteTable): string[] {
  return Object.keys(table).sort();
}

/** The `FerryRoutes` member for one route: `'users.show': { user: string | number };`. */
function ferryRoutesMember(entry: RouteEntry): string {
  if (entry.params.length === 0) {
    return `  '${entry.name}': {};`;
  }
  const fields = entry.params
    .map((p) => `${p.name}${p.optional ? '?' : ''}: string | number`)
    .join('; ');
  return `  '${entry.name}': { ${fields} };`;
}

/**
 * Every segment-boundary prefix of a route name, suffixed `.*`. `admin.users.show`
 * contributes `admin.*` and `admin.users.*`. Single-segment names contribute nothing.
 */
export function wildcardPrefixes(names: string[]): string[] {
  const prefixes = new Set<string>();
  for (const name of names) {
    const segments = name.split('.');
    for (let i = 1; i < segments.length; i++) {
      prefixes.add(segments.slice(0, i).join('.') + '.*');
    }
  }
  return [...prefixes].sort();
}

/**
 * The script-style top-level declarations for `@ferry/route`: the static helper
 * types, the generated `FerryRoutes` interface and `FerryRouteWildcard` union, the
 * `route` function, and the `route.isCurrent` namespace. These are TOP-LEVEL ambient
 * declarations (not a `declare module` block) so `route` is globally available; the
 * block contains no top-level import/export, keeping the ambient file a script.
 */
export function generateRoutesDts(table: RouteTable): string {
  const names = sortedNames(table);

  const routesBody = names.length === 0 ? '' : '\n' + names.map((n) => ferryRoutesMember(table[n])).join('\n') + '\n';
  const ferryRoutes = `interface FerryRoutes {${routesBody}}`;

  const prefixes = wildcardPrefixes(names);
  const wildcard =
    prefixes.length === 0
      ? `type FerryRouteWildcard = never;`
      : `type FerryRouteWildcard =\n${prefixes.map((p) => `  | '${p}'`).join('\n')};`;

  return [
    `type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';`,
    `type QueryValue = string | number | boolean | null | undefined | Array<string | number>;`,
    `type QueryBag = Record<string, QueryValue>;`,
    `type RouteResult = {\n  url: string;\n  method: HttpMethod;\n  toString(): string;\n  [Symbol.toPrimitive](hint: string): string;\n};`,
    ferryRoutes,
    wildcard,
    [
      `declare function route<`,
      `  R extends string | RouteResult = RouteResult,`,
      `  K extends keyof FerryRoutes = keyof FerryRoutes,`,
      `>(`,
      `  name: K,`,
      // Require a params argument only when the route has at least one REQUIRED param.
      // `{} extends FerryRoutes[K]` holds when every param is optional (or there are none),
      // so `/archive/{year?}` still accepts `route('archive')`.
      `  ...args: {} extends FerryRoutes[K]`,
      `    ? [params?: FerryRoutes[K] & QueryBag]`,
      `    : [params: FerryRoutes[K] & QueryBag]`,
      // Any string-subtype type argument yields a string (the codemod appends `.url` whenever
      // a type argument is present): `route<string>`, `route<'fixed'>`, or an alias resolving
      // to string. The default (no type arg) is RouteResult; a non-string type argument fails
      // the `extends string | RouteResult` constraint. The return widens to `string`, never
      // the echoed literal — matching what the codemod actually rewrites.
      `): R extends string ? string : RouteResult;`,
    ].join('\n'),
    [
      `declare namespace route {`,
      `  function isCurrent<K extends keyof FerryRoutes>(name: K, params?: FerryRoutes[K]): boolean;`,
      `  function isCurrent(pattern: FerryRouteWildcard): boolean;`,
      `}`,
    ].join('\n'),
  ].join('\n\n');
}

/**
 * Collect routes and register the runtime resolver (virtual module) and the top-level
 * route declarations (d.ts block) under `@ferry/route`. Returns the route table so the
 * plugin can feed it to the codemod. Does not write the ambient file; the caller runs
 * `writeTypes()`.
 */
export function registerRoutes({ cwd, delivery }: RouteRegisterOptions): RouteTable {
  const table = collectRoutes(cwd);
  delivery.virtual.register(ROUTE_MODULE_ID, ROUTE_RUNTIME);
  delivery.dts.register(ROUTE_MODULE_ID, generateRoutesDts(table));
  return table;
}
