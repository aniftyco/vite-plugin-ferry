import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  collectEnums,
  generateEnumRuntimeClass,
  generateEnumsRuntime,
  generateEnumDtsClass,
  generateEnumsDts,
} from '../src/generators/enums.js';
import type { EnumDefinition } from '../src/utils/php-parser.js';
import { dedent } from './utils.js';

const fixturesDir = join(import.meta.dirname, 'fixtures');

const orderStatus: EnumDefinition = {
  name: 'OrderStatus',
  backing: 'string',
  cases: [
    { key: 'PENDING', value: 'pending', label: 'Pending Order' },
    { key: 'APPROVED', value: 'approved', label: 'Approved' },
    { key: 'REJECTED', value: 'rejected', label: 'Rejected' },
  ],
};

const role: EnumDefinition = {
  name: 'Role',
  backing: 'string',
  cases: [
    { key: 'ADMIN', value: 'admin' },
    { key: 'USER', value: 'user' },
  ],
};

const priority: EnumDefinition = {
  name: 'Priority',
  backing: 'int',
  cases: [
    { key: 'LOW', value: 1 },
    { key: 'HIGH', value: 3 },
  ],
};

// Unbacked PHP enum (`case RED;`): the parser sets each value to the case name.
const color: EnumDefinition = {
  name: 'Color',
  backing: null,
  cases: [
    { key: 'RED', value: 'RED' },
    { key: 'GREEN', value: 'GREEN' },
    { key: 'BLUE', value: 'BLUE' },
  ],
};

describe('collectEnums', () => {
  it('collects all enums from directory', () => {
    const enums = collectEnums(join(fixturesDir, 'Enums'), fixturesDir);

    expect(Object.keys(enums).sort()).toEqual(['Color', 'OrderStatus', 'Priority', 'Role']);
  });

  it('returns empty object for non-existent directory', () => {
    const enums = collectEnums('/non/existent/directory', '/');
    expect(enums).toEqual({});
  });
});

describe('generateEnumRuntimeClass', () => {
  it('emits a labeled enum class with the label as the third argument', () => {
    expect(generateEnumRuntimeClass(orderStatus)).toBe(dedent`
      export class OrderStatus extends Enum {
        static PENDING = new OrderStatus('PENDING', 'pending', 'Pending Order');
        static APPROVED = new OrderStatus('APPROVED', 'approved', 'Approved');
        static REJECTED = new OrderStatus('REJECTED', 'rejected', 'Rejected');
      }
    `.trimEnd());
  });

  it('emits an unlabeled enum class with two arguments', () => {
    expect(generateEnumRuntimeClass(role)).toBe(dedent`
      export class Role extends Enum {
        static ADMIN = new Role('ADMIN', 'admin');
        static USER = new Role('USER', 'user');
      }
    `.trimEnd());
  });

  it('keeps int-backed values numeric', () => {
    expect(generateEnumRuntimeClass(priority)).toBe(dedent`
      export class Priority extends Enum {
        static LOW = new Priority('LOW', 1);
        static HIGH = new Priority('HIGH', 3);
      }
    `.trimEnd());
  });

  it('uses the case name as the value for an unbacked enum', () => {
    expect(generateEnumRuntimeClass(color)).toBe(dedent`
      export class Color extends Enum {
        static RED = new Color('RED', 'RED');
        static GREEN = new Color('GREEN', 'GREEN');
        static BLUE = new Color('BLUE', 'BLUE');
      }
    `.trimEnd());
  });
});

describe('generateEnumsRuntime', () => {
  it('imports the base Enum and emits every enum class, sorted by name', () => {
    const runtime = generateEnumsRuntime({ Role: role, Priority: priority });

    expect(runtime).toBe(dedent`
      import { Enum } from '@ferry/enum';

      export class Priority extends Enum {
        static LOW = new Priority('LOW', 1);
        static HIGH = new Priority('HIGH', 3);
      }

      export class Role extends Enum {
        static ADMIN = new Role('ADMIN', 'admin');
        static USER = new Role('USER', 'user');
      }
    `);
  });

  it('emits an empty module when there are no enums', () => {
    expect(generateEnumsRuntime({})).toBe('export {};\n');
  });
});

describe('generateEnumDtsClass', () => {
  it('narrows statics to the enum value/key unions for a labeled enum', () => {
    expect(generateEnumDtsClass(orderStatus)).toBe(dedent`
      export type OrderStatusValue = 'pending' | 'approved' | 'rejected';
      export class OrderStatus extends Enum<OrderStatusValue> {
        static readonly PENDING: OrderStatus;
        static readonly APPROVED: OrderStatus;
        static readonly REJECTED: OrderStatus;
        readonly key: 'PENDING' | 'APPROVED' | 'REJECTED';
        readonly value: OrderStatusValue;
        readonly label: string | undefined;
        static from(value: OrderStatusValue): OrderStatus;
        static values(): OrderStatusValue[];
        static keys(): Array<'PENDING' | 'APPROVED' | 'REJECTED'>;
        static cases(): OrderStatus[];
        static options(): Array<{ value: OrderStatusValue; label: string | undefined }>;
      }
    `.trimEnd());
  });

  it('builds the value union from case names for an unbacked enum', () => {
    expect(generateEnumDtsClass(color)).toBe(dedent`
      export type ColorValue = 'RED' | 'GREEN' | 'BLUE';
      export class Color extends Enum<ColorValue> {
        static readonly RED: Color;
        static readonly GREEN: Color;
        static readonly BLUE: Color;
        readonly key: 'RED' | 'GREEN' | 'BLUE';
        readonly value: ColorValue;
        readonly label: string | undefined;
        static from(value: ColorValue): Color;
        static values(): ColorValue[];
        static keys(): Array<'RED' | 'GREEN' | 'BLUE'>;
        static cases(): Color[];
        static options(): Array<{ value: ColorValue; label: string | undefined }>;
      }
    `.trimEnd());
  });

  it('uses a numeric value union for int-backed enums', () => {
    expect(generateEnumDtsClass(priority)).toBe(dedent`
      export type PriorityValue = 1 | 3;
      export class Priority extends Enum<PriorityValue> {
        static readonly LOW: Priority;
        static readonly HIGH: Priority;
        readonly key: 'LOW' | 'HIGH';
        readonly value: PriorityValue;
        readonly label: string | undefined;
        static from(value: PriorityValue): Priority;
        static values(): PriorityValue[];
        static keys(): Array<'LOW' | 'HIGH'>;
        static cases(): Priority[];
        static options(): Array<{ value: PriorityValue; label: string | undefined }>;
      }
    `.trimEnd());
  });
});

describe('generateEnumsDts', () => {
  it('wraps the enum classes in a declare module block with an inner Enum import', () => {
    const dts = generateEnumsDts({ Role: role });

    expect(dts).toBe(dedent`
      declare module '@ferry/enums' {
        import { Enum } from '@ferry/enum';

        export type RoleValue = 'admin' | 'user';
        export class Role extends Enum<RoleValue> {
          static readonly ADMIN: Role;
          static readonly USER: Role;
          readonly key: 'ADMIN' | 'USER';
          readonly value: RoleValue;
          readonly label: string | undefined;
          static from(value: RoleValue): Role;
          static values(): RoleValue[];
          static keys(): Array<'ADMIN' | 'USER'>;
          static cases(): Role[];
          static options(): Array<{ value: RoleValue; label: string | undefined }>;
        }
      }
    `.trimEnd());
  });

  it('emits an empty declare module block when there are no enums', () => {
    expect(generateEnumsDts({})).toBe(`declare module '@ferry/enums' {}`);
  });
});
