/**
 * The runtime `route()` resolver served at `@ferry/route`. Static and route-table
 * independent: the codemod rewrites each call site so the URI PATTERN (and HTTP
 * method) arrive inline as arguments, so the full route table never ships — only
 * the patterns of routes actually referenced end up in the bundle.
 *
 * Signature at runtime: `route(pattern, params, method)`. The codemod guarantees
 * `pattern` is a literal URI (e.g. `/users/{user}`), always emits the `params` slot
 * (`undefined` when absent), and appends the lowercased `method`. `route.isCurrent`
 * takes a single pattern or an array of patterns (the codemod expands a wildcard to
 * the matching routes' patterns at build time).
 */
export const ROUTE_RUNTIME = `function fill(pattern, params) {
  const values = { ...(params || {}) };
  let url = pattern.replace(/\\{(\\w+)(?::\\w+)?\\??\\}/g, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(values, key) && values[key] != null) {
      const v = values[key];
      delete values[key];
      return encodeURIComponent(v);
    }
    delete values[key];
    return '';
  });
  url = url.replace(/\\/{2,}/g, '/');
  if (url.length > 1) url = url.replace(/\\/$/, '');

  const query = new URLSearchParams();
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) query.append(key + '[]', String(item));
    } else {
      query.append(key, String(value));
    }
  }
  const qs = query.toString();
  return qs ? url + '?' + qs : url;
}

function toRegExp(pattern) {
  const OPT = '\\x00OPT\\x00';
  const REQ = '\\x00REQ\\x00';
  let source = pattern
    .replace(/\\/\\{\\w+(?::\\w+)?\\?\\}/g, OPT)
    .replace(/\\{\\w+(?::\\w+)?\\??\\}/g, REQ)
    .replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')
    .split(OPT).join('(?:/[^/]+)?')
    .split(REQ).join('[^/]+');
  return new RegExp('^' + source + '$');
}

export function route(pattern, params, method) {
  const url = fill(pattern, params);
  return {
    url,
    method,
    toString() {
      return this.url;
    },
    [Symbol.toPrimitive]() {
      return this.url;
    },
  };
}

route.isCurrent = function isCurrent(patternOrPatterns, params) {
  if (typeof window === 'undefined' || !window.location) return false;
  const path = window.location.pathname;
  // Exact pattern + params -> this route, THIS param: fill the pattern and compare the
  // concrete path. Extra (query) keys don't affect the path comparison.
  if (params && !Array.isArray(patternOrPatterns)) {
    return fill(patternOrPatterns, params).split('?')[0] === path;
  }
  // No params (or an expanded wildcard array) -> on this route, any params.
  const patterns = Array.isArray(patternOrPatterns) ? patternOrPatterns : [patternOrPatterns];
  return patterns.some((pattern) => toRegExp(pattern).test(path));
};
`;
