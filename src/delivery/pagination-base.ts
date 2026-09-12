/**
 * The `@ferry/pagination` declaration block for the ambient `index.d.ts`. Three fixed
 * generic envelopes — one per Laravel paginator kind — verified against the real
 * `paginate()`/`simplePaginate()`/`cursorPaginate()` JSON serialization (Laravel 13.31.0).
 * Static and zero-dep, so it's registered directly as a `declare module` block, the same
 * pattern `@ferry/enum` uses.
 */
export const PAGINATION_BASE_DTS = `declare module '@ferry/pagination' {
  export type LengthAwarePaginated<T> = {
    data: T[];
    links: { first: string | null; last: string | null; prev: string | null; next: string | null };
    meta: {
      current_page: number;
      from: number | null;
      last_page: number;
      links: { url: string | null; label: string; page: number | null; active: boolean }[];
      path: string;
      per_page: number;
      to: number | null;
      total: number;
    };
  };

  export type SimplePaginated<T> = {
    data: T[];
    links: { first: string | null; last: null; prev: string | null; next: string | null };
    meta: {
      current_page: number;
      current_page_url: string;
      from: number | null;
      path: string;
      per_page: number;
      to: number | null;
    };
  };

  export type CursorPaginated<T> = {
    data: T[];
    links: { first: null; last: null; prev: string | null; next: string | null };
    meta: {
      path: string;
      per_page: number;
      next_cursor: string | null;
      prev_cursor: string | null;
    };
  };
}`;
