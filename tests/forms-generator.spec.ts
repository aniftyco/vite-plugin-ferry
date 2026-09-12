import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { assembleAmbientTypes } from '../src/delivery/ambient-types.js';
import { ENUM_BASE_DTS } from '../src/delivery/enum-base.js';
import { collectEnums, generateEnumsDts } from '../src/generators/enums.js';
import {
  FORM_RUNTIME,
  collectFormInputs,
  buildForms,
  generateFormsDtsBlock,
  type FormEntry,
  type FormInput,
} from '../src/generators/forms.js';
import { parseFormRequestRules } from '../src/utils/php-parser.js';
import { dedent } from './utils.js';

const fixturesDir = join(import.meta.dirname, 'fixtures');
const repoRoot = join(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const tscPath = require.resolve('typescript/bin/tsc');

const enums = collectEnums(join(fixturesDir, 'Enums'), fixturesDir);
const knownEnums = new Set(Object.keys(enums));

function formInputs(): FormInput[] {
  return collectFormInputs({ requestsDir: join(fixturesDir, 'Requests'), cwd: fixturesDir });
}

function build(strict = false) {
  return buildForms(formInputs(), strict, enums, knownEnums);
}

function fieldsOf(forms: Record<string, FormEntry>, name: string): Record<string, { type: string; optional: boolean }> {
  const entry = forms[name];
  expect(entry?.kind).toBe('shape');
  return (entry as Extract<FormEntry, { kind: 'shape' }>).fields;
}

describe('FORM_RUNTIME', () => {
  it('is an empty type-only module', () => {
    expect(FORM_RUNTIME).toBe('export {};\n');
  });
});

describe('parseFormRequestRules', () => {
  it('reads pipe-string and array rule tokens, dropping non-string items', () => {
    const php = dedent`
      <?php
      class StoreUserRequest {
          public function rules(): array
          {
              return [
                  'name' => 'required|string',
                  'active' => ['required', 'boolean'],
                  'avatar' => ['required', Rule::exists('files', 'id')],
                  'callback' => ['required', function ($a, $v, $f) {}],
              ];
          }
      }
    `;

    expect(parseFormRequestRules(php)).toEqual({
      name: ['required', 'string'],
      active: ['required', 'boolean'],
      // The Rule::exists(...) item carries no static token and is dropped.
      avatar: ['required'],
      // The closure item is dropped too.
      callback: ['required'],
    });
  });

  it('emits a synthetic enum:<Short> token for Rule::enum(Enum::class)', () => {
    const php = dedent`
      <?php
      use Illuminate\\Validation\\Rule;
      class StoreUserRequest {
          public function rules(): array
          {
              return [
                  'role' => ['required', Rule::enum(Role::class)],
                  'priority' => ['required', Rule::enum(\\App\\Enums\\Priority::class)],
              ];
          }
      }
    `;

    expect(parseFormRequestRules(php)).toEqual({
      role: ['required', 'enum:Role'],
      // A fully-qualified class name resolves to its short name.
      priority: ['required', 'enum:Priority'],
    });
  });

  it('returns null when no rules() method returning an array literal is found', () => {
    expect(parseFormRequestRules('<?php class Foo {}')).toBeNull();
    expect(
      parseFormRequestRules('<?php class Foo { public function rules(): array { return $this->all(); } }')
    ).toBeNull();
  });
});

describe('buildForms — rule → type mapping', () => {
  it('maps scalar rules, nullable, sometimes, and in: enums off the fixtures', () => {
    const { forms } = build();
    const f = fieldsOf(forms, 'StoreUserRequest');

    // required|string / required|email -> string, key present.
    expect(f.name).toEqual({ type: 'string', optional: false });
    expect(f.email).toEqual({ type: 'string', optional: false });

    // nullable|integer -> number | null, key present (nullable is a value modifier).
    expect(f.age).toEqual({ type: 'number | null', optional: false });

    // sometimes|string -> string, key optional.
    expect(f.bio).toEqual({ type: 'string', optional: true });

    // in: -> a string-literal union.
    expect(f.role).toEqual({ type: "'admin' | 'editor' | 'viewer'", optional: false });

    // array rule with array-item tokens -> boolean.
    expect(f.active).toEqual({ type: 'boolean', optional: false });

    // A bare array rule with no nested keys -> any[]; sometimes -> optional.
    expect(f.tags).toEqual({ type: 'any[]', optional: true });
  });

  it('expands nested and wildcard keys into nested objects and arrays', () => {
    const { forms } = build();
    const f = fieldsOf(forms, 'StoreUserRequest');

    // profile.bio nests under profile; bio is nullable, key present.
    expect(f.profile).toEqual({ type: '{ bio: string | null }', optional: false });

    // items.*.id / items.*.label -> array of the nested object shape.
    expect(f.items).toEqual({ type: '{ id: number; label: string | null }[]', optional: false });
  });

  it('degrades a field with no mappable rule to the fallback with a warning', () => {
    const { forms, warnings } = build();
    const f = fieldsOf(forms, 'StoreUserRequest');

    // avatar's only non-modifier rule (Rule::exists) was dropped -> no type signal -> any.
    expect(f.avatar).toEqual({ type: 'any', optional: false });
    // callback's closure rule dropped likewise.
    expect(f.callback).toEqual({ type: 'any', optional: false });

    expect(warnings.some((w) => w.includes('StoreUserRequest.avatar'))).toBe(true);
    expect(warnings.some((w) => w.includes('StoreUserRequest.callback'))).toBe(true);
  });

  it('maps accepted, file rules, Rule::enum, and honors @ferry pins', () => {
    const { forms, warnings } = build();
    const f = fieldsOf(forms, 'StoreUserRequest');

    // accepted -> boolean.
    expect(f.terms).toEqual({ type: 'boolean', optional: false });

    // file rules -> the DOM File type; nullable -> File | null.
    expect(f.photo).toEqual({ type: 'File', optional: false });
    expect(f.attachment).toEqual({ type: 'File | null', optional: false });

    // Rule::enum(Enum::class) -> the enum's backing-value union type.
    expect(f.assigned_role).toEqual({ type: 'RoleValue', optional: false });
    expect(f.priority).toEqual({ type: 'PriorityValue', optional: false });

    // @ferry pin wins verbatim over the degrade path AND clears the degrade warning.
    expect(f.meta).toEqual({ type: 'Record<string, string>', optional: false });
    expect(warnings.some((w) => w.includes('StoreUserRequest.meta'))).toBe(false);
  });

  it('rewrites a bare known-enum name in a @ferry pin to its <Enum>Value backing-value union', () => {
    const { forms } = buildForms(
      [
        {
          className: 'StorePickRequest',
          rules: {
            priority: ['required'],
            detail: ['required'],
            explicit: ['required'],
          },
          annotations: {
            priority: 'Priority', // bare name → value union
            detail: '{ value: Priority; label: string }', // bare name inside an object literal
            explicit: 'PriorityValue', // already the value form — must not double-suffix
          },
        },
      ],
      false,
      enums,
      knownEnums
    );

    const f = fieldsOf(forms, 'StorePickRequest');
    expect(f.priority).toEqual({ type: 'PriorityValue', optional: false });
    expect(f.detail).toEqual({ type: '{ value: PriorityValue; label: string }', optional: false });
    expect(f.explicit).toEqual({ type: 'PriorityValue', optional: false });
  });

  it('inlines the backing-value union when the enum is collected but not a known ferry enum', () => {
    const { forms } = buildForms(
      [{ className: 'PickRequest', rules: { status: ['required', 'enum:Role'] }, annotations: {} }],
      false,
      enums,
      new Set()
    );
    // Role is int/string-backed with cases admin|user|guest — inlined as the string union.
    expect(fieldsOf(forms, 'PickRequest').status).toEqual({
      type: "'admin' | 'user' | 'guest'",
      optional: false,
    });
  });

  it('degrades a Rule::enum whose enum ferry cannot resolve, with a warning', () => {
    const { forms, warnings } = buildForms(
      [{ className: 'PickRequest', rules: { status: ['required', 'enum:Ghost'] }, annotations: {} }],
      false
    );
    expect(fieldsOf(forms, 'PickRequest').status).toEqual({ type: 'any', optional: false });
    expect(warnings.some((w) => w.includes('PickRequest.status'))).toBe(true);
  });

  it('uses unknown as the fallback under strict:true', () => {
    const { forms } = build(true);
    const f = fieldsOf(forms, 'StoreUserRequest');
    expect(f.avatar).toEqual({ type: 'unknown', optional: false });
  });

  it('falls a form whose rules() cannot be analyzed back to a Record type with a warning', () => {
    const { forms, warnings } = buildForms([{ className: 'WeirdRequest', rules: null, annotations: {} }], false);
    expect(forms.WeirdRequest).toEqual({ kind: 'fallback', record: 'any' });
    expect(warnings[0]).toContain('WeirdRequest');
  });
});

describe('collectFormInputs', () => {
  it('collects every form request in the directory', () => {
    const names = formInputs().map((i) => i.className);
    expect(names).toContain('StoreUserRequest');
    expect(names).toContain('UpdatePostRequest');
  });

  it('returns no forms when the requests directory is absent', () => {
    expect(collectFormInputs({ requestsDir: join(fixturesDir, 'DoesNotExist'), cwd: fixturesDir })).toEqual([]);
  });
});

describe('generateFormsDtsBlock', () => {
  it('renders one export type per form request under the @ferry/forms module', () => {
    const { forms, enumNames } = build();
    const block = generateFormsDtsBlock(forms, enumNames);

    expect(block).toContain(`declare module '@ferry/forms' {`);
    expect(block).toContain('export type StoreUserRequest = {');
    expect(block).toContain('export type UpdatePostRequest = {');
    expect(block).toContain("role: 'admin' | 'editor' | 'viewer';");
    expect(block).toContain('items: { id: number; label: string | null }[];');
    expect(block).toContain('profile: { bio: string | null };');
    expect(block).toContain('bio?: string;');

    // Rule::enum() fields type as the enum's backing-value union, imported from @ferry/enums.
    expect(block).toContain(`import { PriorityValue, RoleValue } from '@ferry/enums';`);
    expect(block).toContain('assigned_role: RoleValue;');
    expect(block).toContain('priority: PriorityValue;');
  });

  it('imports a pinned <Enum>Value even when no Rule::enum resolved it, driving off knownEnums', () => {
    // A `@ferry` pin naming `PriorityValue` never populates the resolution-tracked
    // `enumNames`; the import must be driven off the known-enum set instead.
    const forms: Record<string, FormEntry> = {
      StorePickRequest: {
        kind: 'shape',
        fields: {
          id: { type: 'number', optional: false },
          priority: { type: '{ value: PriorityValue; label: string }', optional: false },
        },
      },
    };

    const block = generateFormsDtsBlock(forms, new Set(), new Set(['Priority']));
    expect(block).toContain(`import { PriorityValue } from '@ferry/enums';`);
  });

  it('emits an empty declare module block when there are no forms', () => {
    expect(generateFormsDtsBlock({})).toBe(`declare module '@ferry/forms' {}`);
  });
});

// ---------------------------------------------------------------------------
// tsc --noEmit consumer check
// ---------------------------------------------------------------------------

/**
 * Type-check a consumer against the assembled ambient script file. The temp project lives
 * inside the repo so upward node_modules resolution finds the real `@inertiajs/core`, making
 * the `FormDataKeys` error-key derivation a real check rather than a stub.
 */
function typecheck(ambient: string, consumer: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(repoRoot, 'ferry-forms-'));
  try {
    writeFileSync(join(dir, 'index.d.ts'), ambient, 'utf8');
    writeFileSync(join(dir, 'consumer.ts'), consumer, 'utf8');
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'esnext',
          lib: ['esnext', 'dom'],
          moduleResolution: 'bundler',
          module: 'esnext',
          skipLibCheck: true,
          noEmit: true,
          types: [],
        },
        files: ['index.d.ts', 'consumer.ts'],
      }),
      'utf8'
    );

    const result = spawnSync(process.execPath, [tscPath, '--project', join(dir, 'tsconfig.json')], {
      encoding: 'utf8',
    });

    return { ok: result.status === 0, output: (result.stdout ?? '') + (result.stderr ?? '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('generated form types (tsc --noEmit consumer check)', () => {
  const { forms, enumNames } = build();
  const ambient = assembleAmbientTypes({
    blocks: [ENUM_BASE_DTS, generateEnumsDts(enums), generateFormsDtsBlock(forms, enumNames)],
  });

  it('is a script-style ambient file (zero top-level import/export)', () => {
    const topLevel = ambient.split('\n').filter((line) => /^(import|export)\b/.test(line));
    expect(topLevel).toEqual([]);
  });

  it('types useForm<StoreUserRequest>() fields AND derives error keys via FormDataKeys', () => {
    const consumer = dedent`
      import type { StoreUserRequest } from '@ferry/forms';
      import type { FormDataKeys } from '@inertiajs/core';

      // A minimal useForm mirroring Inertia: the generic is the data shape, and error keys
      // are derived from it by Inertia's own FormDataKeys<TForm>.
      declare function useForm<T extends object>(data: T): {
        data: T;
        errors: Partial<Record<FormDataKeys<T>, string>>;
        setData<K extends keyof T>(key: K, value: T[K]): void;
      };

      const form = useForm<StoreUserRequest>({
        name: '',
        email: '',
        age: null,
        role: 'admin',
        active: true,
        profile: { bio: null },
        items: [{ id: 1, label: null }],
        avatar: null,
        callback: null,
        terms: true,
        photo: new File([], 'p.jpg'),
        attachment: null,
        assigned_role: 'admin',
        priority: 1,
        meta: { theme: 'dark' },
      });

      // Field types are enforced from the rules.
      const name: string = form.data.name;
      const age: number | null = form.data.age;
      const firstId: number = form.data.items[0].id;
      const bio: string | null = form.data.profile.bio;
      const role: 'admin' | 'editor' | 'viewer' = form.data.role;

      // accepted -> boolean; file rule -> File (nullable -> File | null); pin -> verbatim.
      const terms: boolean = form.data.terms;
      const photo: File = form.data.photo;
      const attachment: File | null = form.data.attachment;
      const meta: Record<string, string> = form.data.meta;

      // Rule::enum() -> the enum's backing-value union.
      const assignedRole: 'admin' | 'user' | 'guest' = form.data.assigned_role;
      const priority: 1 | 2 | 3 | 4 = form.data.priority;

      // AC2: error keys resolve via FormDataKeys — top-level, nested, and wildcard-array.
      const e1: string | undefined = form.errors['name'];
      const e2: string | undefined = form.errors['profile.bio'];
      const e3: string | undefined = form.errors['items.0.id'];
      const e4: string | undefined = form.errors['role'];

      // @ts-expect-error an unknown error key is rejected
      const bad = form.errors['nope.nope'];

      // @ts-expect-error age is number | null, not string
      const badAge: string = form.data.age;

      // Negative checks that a wrong type is rejected. If any field degraded to \`any\`
      // instead of its mapped type, the directive below it would be unused and fail tsc,
      // so these actively prove accepted/file/enum/pin resolution.

      // @ts-expect-error terms is boolean, not string
      const badTerms: string = form.data.terms;

      // @ts-expect-error photo is File, not string
      const badPhoto: string = form.data.photo;

      // @ts-expect-error 'nope' is a File field, not a string value
      form.setData('photo', 'nope');

      // @ts-expect-error 'manager' is outside the RoleValue backing-value union
      const badRole: typeof form.data.assigned_role = 'manager';

      // @ts-expect-error 5 is outside the PriorityValue backing-value union
      const badPriority: typeof form.data.priority = 5;

      // @ts-expect-error the meta pin is Record<string, string>, not Record<string, number>
      const badMeta: Record<string, number> = form.data.meta;
    `;

    const { ok, output } = typecheck(ambient, consumer);
    expect(ok, `tsc reported errors:\n${output}`).toBe(true);
  });
});

describe('a pinned <Enum>Value resolves to the real union, not any (tsc --noEmit)', () => {
  // The natural pin form names the enum's backing-value union. No `Rule::enum` resolves it,
  // so `enumNames` is EMPTY; only the known-enum set carries Priority.
  const forms: Record<string, FormEntry> = {
    StorePickRequest: {
      kind: 'shape',
      fields: {
        id: { type: 'number', optional: false },
        priority: { type: '{ value: PriorityValue; label: string }', optional: false },
      },
    },
  };

  const ambient = assembleAmbientTypes({
    blocks: [ENUM_BASE_DTS, generateEnumsDts(enums), generateFormsDtsBlock(forms, new Set(), knownEnums)],
  });

  it('imports the pinned PriorityValue into the @ferry/forms block', () => {
    expect(ambient).toContain(`import { PriorityValue } from '@ferry/enums';`);
  });

  it('types the pinned field, so a wrong value assignment errors (proving it is not any)', () => {
    const consumer = dedent`
      import type { StorePickRequest } from '@ferry/forms';

      declare const req: StorePickRequest;

      // @ts-expect-error 99 is outside the PriorityValue backing-value union.
      // Were the field silently \`any\`, this directive would be unused and tsc would fail (TS2578).
      req.priority.value = 99;
    `;

    const { ok, output } = typecheck(ambient, consumer);
    expect(ok, `tsc reported errors:\n${output}`).toBe(true);
  });
});

describe('a bare enum-name form pin resolves to its value union end-to-end (tsc --noEmit)', () => {
  const { forms } = buildForms(
    [{ className: 'StorePickRequest', rules: { priority: ['required'] }, annotations: { priority: 'Priority' } }],
    false,
    enums,
    knownEnums
  );

  const ambient = assembleAmbientTypes({
    blocks: [ENUM_BASE_DTS, generateEnumsDts(enums), generateFormsDtsBlock(forms, new Set(), knownEnums)],
  });

  it('emits PriorityValue and imports it', () => {
    expect(ambient).toContain('priority: PriorityValue;');
    expect(ambient).toContain(`import { PriorityValue } from '@ferry/enums';`);
  });

  it('types the field, so a wrong value assignment errors (proving it is not any)', () => {
    const consumer = dedent`
      import type { StorePickRequest } from '@ferry/forms';
      declare const req: StorePickRequest;

      // @ts-expect-error 99 is outside the PriorityValue backing-value union.
      req.priority = 99;
    `;
    const { ok, output } = typecheck(ambient, consumer);
    expect(ok, `tsc reported errors:\n${output}`).toBe(true);
  });
});
