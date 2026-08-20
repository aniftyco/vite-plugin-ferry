import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeAll } from 'vitest';
import { collectEnums, generateEnumsRuntime, generateEnumsDts } from '../src/generators/enums.js';
import { assembleAmbientTypes } from '../src/delivery/ambient-types.js';
import { ENUM_BASE_RUNTIME, ENUM_BASE_DTS } from '../src/delivery/enum-base.js';
import { dedent } from './utils.js';

const fixturesDir = join(import.meta.dirname, 'fixtures');
const require = createRequire(import.meta.url);
const tscPath = require.resolve('typescript/bin/tsc');

// A frozen enum instance as it behaves at runtime: readonly key/value/label plus the
// base-class methods. Kept loose (`any` value) since it spans string- and int-backed enums.
type EnumInstance = {
  readonly key: string;
  readonly value: any;
  readonly label: string | undefined;
  is(other: EnumInstance): boolean;
  toString(): string;
};

type EnumClass = {
  new (...args: any[]): EnumInstance;
  from(value: unknown): EnumInstance | undefined;
  values(): any[];
  keys(): string[];
  cases(): EnumInstance[];
  options(): Array<{ value: any; label: string | undefined }>;
  [caseKey: string]: any;
};

let OrderStatus: EnumClass;
let Priority: EnumClass;
let Role: EnumClass;
let Color: EnumClass;

beforeAll(async () => {
  // Assemble the real delivered runtime: the base `Enum` at @ferry/enum plus the generated
  // subclasses, then execute it for real. The generated module imports from '@ferry/enum';
  // rewrite that bare specifier to the sibling base file so the ES import resolves.
  const dir = mkdtempSync(join(tmpdir(), 'ferry-enum-'));
  const baseFile = join(dir, 'enum.mjs');
  const enumsFile = join(dir, 'enums.mjs');

  const enums = collectEnums(join(fixturesDir, 'Enums'), fixturesDir);
  const runtime = generateEnumsRuntime(enums).replace(`'@ferry/enum'`, `'./enum.mjs'`);

  writeFileSync(baseFile, ENUM_BASE_RUNTIME, 'utf8');
  writeFileSync(enumsFile, runtime, 'utf8');

  ({ OrderStatus, Priority, Role, Color } = await import(pathToFileURL(enumsFile).href));
});

describe('base Enum runtime behavior (E12)', () => {
  it('cases() returns every case instance in declaration order', () => {
    expect(OrderStatus.cases().map((c) => c.key)).toEqual(['PENDING', 'APPROVED', 'REJECTED', 'SHIPPED']);
    expect(OrderStatus.cases()).toEqual([
      OrderStatus.PENDING,
      OrderStatus.APPROVED,
      OrderStatus.REJECTED,
      OrderStatus.SHIPPED,
    ]);
  });

  it('from() returns the matching instance and undefined for an unknown value', () => {
    expect(OrderStatus.from('pending')).toBe(OrderStatus.PENDING);
    expect(OrderStatus.from('bogus')).toBeUndefined();
  });

  it('values() and keys() return parallel value/key arrays', () => {
    expect(OrderStatus.values()).toEqual(['pending', 'approved', 'rejected', 'shipped']);
    expect(OrderStatus.keys()).toEqual(['PENDING', 'APPROVED', 'REJECTED', 'SHIPPED']);
  });

  it('options() returns {value,label} pairs for every case', () => {
    expect(OrderStatus.options()).toEqual([
      { value: 'pending', label: 'Pending Order' },
      { value: 'approved', label: 'Approved' },
      { value: 'rejected', label: 'Rejected' },
      { value: 'shipped', label: 'Shipped' },
    ]);
  });

  it('is() compares cases by value', () => {
    expect(OrderStatus.PENDING.is(OrderStatus.PENDING)).toBe(true);
    expect(OrderStatus.PENDING.is(OrderStatus.APPROVED)).toBe(false);
  });

  it('toString() returns the backing value', () => {
    expect(OrderStatus.PENDING.toString()).toBe('pending');
    expect(String(OrderStatus.PENDING)).toBe('pending');
    expect(`${OrderStatus.PENDING}`).toBe('pending');
  });

  it('reads key, value and label off the instance', () => {
    expect(OrderStatus.PENDING.key).toBe('PENDING');
    expect(OrderStatus.PENDING.value).toBe('pending');
    expect(OrderStatus.PENDING.label).toBe('Pending Order');
  });

  it('preserves int backing: value is a number', () => {
    expect(typeof Priority.LOW.value).toBe('number');
    expect(Priority.LOW.value).toBe(1);
    expect(Priority.values()).toEqual([1, 2, 3, 4]);
    expect(Priority.values().every((v) => typeof v === 'number')).toBe(true);
    expect(Priority.from(3)).toBe(Priority.HIGH);
  });

  it('leaves label undefined for an unlabeled enum', () => {
    expect(Role.ADMIN.label).toBeUndefined();
    expect(Role.options()).toEqual([
      { value: 'admin', label: undefined },
      { value: 'user', label: undefined },
      { value: 'guest', label: undefined },
    ]);
  });

  it('uses the case name as the value for an unbacked enum', () => {
    expect(Color.RED.value).toBe('RED');
    expect(Color.values()).toEqual(['RED', 'GREEN', 'BLUE']);
  });
});

describe('enum instances are frozen (E13)', () => {
  it('freezes every case instance', () => {
    expect(Object.isFrozen(OrderStatus.PENDING)).toBe(true);
    expect(Object.isFrozen(Priority.LOW)).toBe(true);
  });

  it('throws when mutating a frozen instance (strict-mode ES module)', () => {
    expect(() => {
      (OrderStatus.PENDING as any).value = 'mutated';
    }).toThrow(TypeError);
    // Value is unchanged after the failed write.
    expect(OrderStatus.PENDING.value).toBe('pending');
  });
});

/** Type-check `consumer` against the assembled ambient declarations, returning tsc output. */
function typecheck(ambient: string, consumer: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ferry-enum-types-'));

  writeFileSync(join(dir, 'ferry.d.ts'), ambient, 'utf8');
  writeFileSync(join(dir, 'consumer.ts'), consumer, 'utf8');
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'esnext',
        moduleResolution: 'bundler',
        module: 'esnext',
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
      files: ['ferry.d.ts', 'consumer.ts'],
    }),
    'utf8'
  );

  const result = spawnSync(process.execPath, [tscPath, '--project', join(dir, 'tsconfig.json')], {
    encoding: 'utf8',
  });

  return { ok: result.status === 0, output: (result.stdout ?? '') + (result.stderr ?? '') };
}

describe('generated enum types (tsc --noEmit consumer check) (E10/E16)', () => {
  const ambient = assembleAmbientTypes({
    blocks: [ENUM_BASE_DTS, generateEnumsDts(collectEnums(join(fixturesDir, 'Enums'), fixturesDir))],
  });

  it('is a script-style ambient file (zero top-level import/export)', () => {
    const topLevel = ambient.split('\n').filter((line) => /^(import|export)\b/.test(line));
    expect(topLevel).toEqual([]);
  });

  it('accepts valid enum usage and rejects invalid values in a single pass', () => {
    // Each `@ts-expect-error` requires the next line to error AND fails tsc if it does not,
    // so one clean pass proves the positives compile and the negatives are caught.
    const consumer = dedent`
      import { OrderStatus, type OrderStatusValue } from '@ferry/enums';

      // positive: from(literal) type-checks and is typed as OrderStatus
      const x: OrderStatus = OrderStatus.from('pending');

      // positive: .value is assignable to the value union, .key to the key union
      const v: OrderStatusValue = OrderStatus.PENDING.value;
      const k: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SHIPPED' = OrderStatus.PENDING.key;

      // positive: the instance carries its label
      const l: string | undefined = OrderStatus.PENDING.label;

      const someApiString: string = 'pending';

      // @ts-expect-error 'foobar' is not a valid OrderStatus value
      OrderStatus.from('foobar');

      // @ts-expect-error a plain string is not narrowed to the value union
      OrderStatus.from(someApiString);
    `;

    const { ok, output } = typecheck(ambient, consumer);
    expect(ok, `tsc reported errors:\n${output}`).toBe(true);
  });
});
