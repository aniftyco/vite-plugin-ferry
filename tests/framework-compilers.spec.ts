import { describe, it, expect } from 'vitest';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import { compile as compileSvelte } from 'svelte/compiler';
import { transformRoutesPost, RouteCodemodError } from '../src/codemod/routes.js';
import type { RouteTable } from '../src/generators/routes.js';

const table: RouteTable = {
  'users.index': { name: 'users.index', uri: '/users', method: 'get', params: [] },
  'users.show': { name: 'users.show', uri: '/users/{user}', method: 'get', params: [{ name: 'user', optional: false }] },
  'users.destroy': {
    name: 'users.destroy',
    uri: '/users/{user}',
    method: 'delete',
    params: [{ name: 'user', optional: false }],
  },
};

/**
 * Compile a `<template>` block the way @vitejs/plugin-vue does: parse the SFC, compile the
 * script block to get its binding metadata, then compile the template with that metadata.
 * Returns the real render-function module — an unqualified `route` in the template compiles
 * to a `_ctx.route(...)` member access.
 */
function compileVueTemplate(source: string): string {
  const { descriptor } = parse(source, { filename: 'Comp.vue' });
  const script = compileScript(descriptor, { id: 'ferrytest' });
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: 'Comp.vue',
    id: 'ferrytest',
    scoped: false,
    slotted: false,
    compilerOptions: { bindingMetadata: script.bindings },
  });
  return template.code;
}

describe('Vue: real @vue/compiler-sfc output through the post pass', () => {
  const source = `<script setup lang="ts">
const label = 'show';
</script>
<template>
  <a :href="route('users.show', { user: 1 })">{{ label }}</a>
  <span v-if="route.isCurrent('users.*')">active</span>
</template>
`;

  it('compiles route() in a template to _ctx.route() (the shape the codemod normalizes)', () => {
    const code = compileVueTemplate(source);
    // Guards the codemod's core assumption: an unqualified template `route` becomes `_ctx.route`.
    expect(code).toContain(`_ctx.route('users.show', { user: 1 })`);
    expect(code).toContain(`_ctx.route.isCurrent('users.*')`);
  });

  it('rewrites the compiled template (?vue&type=template sub-request, build form)', () => {
    const code = compileVueTemplate(source);
    const out = transformRoutesPost(code, '/a/Comp.vue?vue&type=template&lang.js', table);

    expect(out?.code).toContain(`route('/users/{user}', { user: 1 }, 'get')`);
    expect(out?.code).toContain(`route.isCurrent(['/users/{user}', '/users'])`);
    // _ctx.route is normalized to the imported bare route so ferry's resolver is the callee.
    expect(out?.code).not.toContain('_ctx.route');
    expect(out?.code.startsWith(`import { route } from '@ferry/route';`)).toBe(true);
  });

  it('rewrites the same compiled render fn served under the main .vue id (dev inline form)', () => {
    // Dev inlines this same render function into the main module; the _ctx.route receiver is
    // identical, so the post pass handles both id forms off one real compiler output.
    const code = compileVueTemplate(source);
    const out = transformRoutesPost(code, '/a/Comp.vue', table);

    expect(out?.code).toContain(`route('/users/{user}', { user: 1 }, 'get')`);
    expect(out?.code).toContain(`route.isCurrent(['/users/{user}', '/users'])`);
    expect(out?.code).not.toContain('_ctx.route');
  });

  it('rewrites a bare route() call surviving from <script setup> (?vue&type=script sub-request)', () => {
    const scriptSource = `<script setup lang="ts">
const url = route('users.show', { user: 1 });
</script>
<template><div>{{ url }}</div></template>
`;
    const { descriptor } = parse(scriptSource, { filename: 'Comp.vue' });
    const script = compileScript(descriptor, { id: 'ferrytest' });
    // A route() call in <script setup> compiles to a bare identifier, not _ctx.route.
    expect(script.content).toContain(`route('users.show', { user: 1 })`);

    const out = transformRoutesPost(
      script.content,
      '/a/Comp.vue?vue&type=script&setup=true&lang.ts',
      table
    );
    expect(out?.code).toContain(`route('/users/{user}', { user: 1 }, 'get')`);
    expect(out?.code.startsWith(`import { route } from '@ferry/route';`)).toBe(true);
  });

  it('does NOT append .url in the post pass (the <string> type argument is stripped by the compiler)', () => {
    const code = compileVueTemplate(source);
    const out = transformRoutesPost(code, '/a/Comp.vue?vue&type=template&lang.js', table);
    expect(out?.code).not.toContain('.url');
  });

  it('throws a build error for a non-literal route name in a compiled template', () => {
    const dynamic = `<script setup lang="ts">
const name = 'users.show';
</script>
<template><a :href="route(name)">x</a></template>
`;
    const code = compileVueTemplate(dynamic);
    expect(() => transformRoutesPost(code, '/a/Comp.vue?vue&type=template&lang.js', table)).toThrow(
      RouteCodemodError
    );
  });
});

describe('Svelte: real svelte/compiler output through the post pass', () => {
  const source = `<script>
</script>
<a href={route('users.show', { user: 1 })}>show</a>
{#if route.isCurrent('users.*')}<span>active</span>{/if}
`;

  function compile(src: string): string {
    return compileSvelte(src, { filename: 'Comp.svelte', generate: 'client', dev: false }).js.code;
  }

  it('compiles markup route() calls to bare identifiers (the shape the codemod expects)', () => {
    const code = compile(source);
    expect(code).toContain(`route('users.show', { user: 1 })`);
    expect(code).toContain(`route.isCurrent('users.*')`);
  });

  it('rewrites route() and route.isCurrent() in the compiled component, injecting the import once', () => {
    const code = compile(source);
    const out = transformRoutesPost(code, '/a/Comp.svelte', table);

    expect(out?.code).toContain(`route('/users/{user}', { user: 1 }, 'get')`);
    expect(out?.code).toContain(`route.isCurrent(['/users/{user}', '/users'])`);
    const occurrences = out?.code.match(/@ferry\/route/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(out?.code.startsWith(`import { route } from '@ferry/route';`)).toBe(true);
  });

  it('rewrites a bare route() call surviving from <script>', () => {
    const scriptSource = `<script>
  const u = route('users.show', { user: 1 });
</script>
<div>{u}</div>
`;
    const code = compile(scriptSource);
    expect(code).toContain(`route('users.show', { user: 1 })`);

    const out = transformRoutesPost(code, '/a/Comp.svelte', table);
    expect(out?.code).toContain(`route('/users/{user}', { user: 1 }, 'get')`);
  });

  it('does NOT append .url in the post pass', () => {
    const code = compile(source);
    const out = transformRoutesPost(code, '/a/Comp.svelte', table);
    expect(out?.code).not.toContain('.url');
  });

  it('throws a build error for a non-literal route name in a compiled component', () => {
    const dynamic = `<script>
  const name = 'users.show';
</script>
<a href={route(name)}>x</a>
`;
    const code = compile(dynamic);
    expect(() => transformRoutesPost(code, '/a/Comp.svelte', table)).toThrow(RouteCodemodError);
  });
});
