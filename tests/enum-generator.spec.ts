import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { generateEnumTypeScript, generateEnumRuntime, collectEnums } from '../src/generators/enums.js';
import type { EnumDefinition } from '../src/utils/php-parser.js';
import { dedent } from './utils.js';

const fixturesDir = join(import.meta.dirname, 'fixtures');

describe('collectEnums', () => {
  it('collects all enums from directory', () => {
    const enums = collectEnums(join(fixturesDir, 'Enums'));

    expect(Object.keys(enums).sort()).toEqual(['Color', 'OrderStatus', 'Priority', 'Role']);
  });

  it('returns empty object for non-existent directory', () => {
    const enums = collectEnums('/non/existent/directory');
    expect(enums).toEqual({});
  });
});

describe('generateEnumTypeScript', () => {
  it('generates const declaration for enum with labels', () => {
    const enums: Record<string, EnumDefinition> = {
      OrderStatus: {
        name: 'OrderStatus',
        backing: 'string',
        cases: [
          { key: 'PENDING', value: 'pending', label: 'Pending Order' },
          { key: 'APPROVED', value: 'approved', label: 'Approved' },
        ],
      },
    };

    const result = generateEnumTypeScript(enums);

    expect(result).toBe(dedent`
      export declare const OrderStatus: {
          PENDING: {
              value: "pending";
              label: "Pending Order";
          };
          APPROVED: {
              value: "approved";
              label: "Approved";
          };
      };
    `);
  });

  it('generates traditional enum for enum without labels', () => {
    const enums: Record<string, EnumDefinition> = {
      Role: {
        name: 'Role',
        backing: 'string',
        cases: [
          { key: 'ADMIN', value: 'admin' },
          { key: 'USER', value: 'user' },
        ],
      },
    };

    const result = generateEnumTypeScript(enums);

    expect(result).toBe(dedent`
      export enum Role {
          ADMIN = "admin",
          USER = "user"
      }
    `);
  });

  it('generates numeric values for int-backed enums', () => {
    const enums: Record<string, EnumDefinition> = {
      Priority: {
        name: 'Priority',
        backing: 'int',
        cases: [
          { key: 'LOW', value: 1 },
          { key: 'HIGH', value: 3 },
        ],
      },
    };

    const result = generateEnumTypeScript(enums);

    expect(result).toBe(dedent`
      export enum Priority {
          LOW = 1,
          HIGH = 3
      }
    `);
  });

  it('generates empty string when no enums', () => {
    const enums: Record<string, EnumDefinition> = {};
    const result = generateEnumTypeScript(enums);

    expect(result).toBe('');
  });
});

describe('generateEnumRuntime', () => {
  it('generates runtime object for enum with labels', () => {
    const enums: Record<string, EnumDefinition> = {
      OrderStatus: {
        name: 'OrderStatus',
        backing: 'string',
        cases: [{ key: 'PENDING', value: 'pending', label: 'Pending Order' }],
      },
    };

    const result = generateEnumRuntime(enums);

    expect(result).toBe(dedent`
      export const OrderStatus = {
          PENDING: {
              value: "pending",
              label: "Pending Order"
          }
      };

      export default {};
    `);
  });

  it('generates runtime object for enum without labels', () => {
    const enums: Record<string, EnumDefinition> = {
      Role: {
        name: 'Role',
        backing: 'string',
        cases: [
          { key: 'ADMIN', value: 'admin' },
          { key: 'USER', value: 'user' },
        ],
      },
    };

    const result = generateEnumRuntime(enums);

    expect(result).toBe(dedent`
      export const Role = {
          ADMIN: "admin",
          USER: "user"
      };

      export default {};
    `);
  });

  it('exports default empty object when no enums', () => {
    const enums: Record<string, EnumDefinition> = {};
    const result = generateEnumRuntime(enums);

    expect(result).toBe('export default {};\n');
  });
});

describe('enum generation integration', () => {
  it('collects and generates complete enum output', () => {
    const enums = collectEnums(join(fixturesDir, 'Enums'));
    const typescript = generateEnumTypeScript(enums);
    const runtime = generateEnumRuntime(enums);

    // Check TypeScript declarations contain expected enums
    expect(typescript).toContain('export enum Color');
    expect(typescript).toContain('RED = "RED"');
    expect(typescript).toContain('export declare const OrderStatus');
    expect(typescript).toContain('PENDING');
    expect(typescript).toContain('"pending"');
    expect(typescript).toContain('export enum Priority');
    expect(typescript).toContain('LOW = 1');
    expect(typescript).toContain('export enum Role');
    expect(typescript).toContain('ADMIN = "admin"');

    // Check runtime contains expected exports
    expect(runtime).toContain('export const Color');
    expect(runtime).toContain('RED: "RED"');
    expect(runtime).toContain('export const OrderStatus');
    expect(runtime).toContain('PENDING: {');
    expect(runtime).toContain('value: "pending"');
    expect(runtime).toContain('label: "Pending Order"');
    expect(runtime).toContain('export const Priority');
    expect(runtime).toContain('LOW: 1');
    expect(runtime).toContain('export const Role');
    expect(runtime).toContain('ADMIN: "admin"');
    expect(runtime).toContain('export default {}');
  });
});
