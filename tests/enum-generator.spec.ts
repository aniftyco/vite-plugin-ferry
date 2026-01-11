import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  collectEnums,
  generateSingleEnumTypeScript,
  generateSingleEnumRuntime,
  generateEnumSourceMap,
} from '../src/generators/enums.js';
import type { EnumDefinition } from '../src/utils/php-parser.js';
import { dedent } from './utils.js';

const fixturesDir = join(import.meta.dirname, 'fixtures');

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

describe('generateSingleEnumTypeScript', () => {
  it('generates TypeScript without phpFile (no JSDoc or source map comment)', () => {
    const enumDef: EnumDefinition = {
      name: 'Role',
      backing: 'string',
      cases: [
        { key: 'ADMIN', value: 'admin' },
        { key: 'USER', value: 'user' },
      ],
    };

    const result = generateSingleEnumTypeScript(enumDef);

    expect(result).toBe(dedent`
      export enum Role {
          ADMIN = "admin",
          USER = "user"
      }
    `);
  });

  it('generates TypeScript with phpFile (includes JSDoc and source map comment)', () => {
    const enumDef: EnumDefinition = {
      name: 'Role',
      backing: 'string',
      cases: [
        { key: 'ADMIN', value: 'admin' },
        { key: 'USER', value: 'user' },
      ],
    };

    const result = generateSingleEnumTypeScript(enumDef, 'app/Enums/Role.php');

    expect(result).toBe(dedent`
      /** @see app/Enums/Role.php */
      export enum Role {
          ADMIN = "admin",
          USER = "user"
      }
      //# sourceMappingURL=Role.d.ts.map
    `);
  });

  it('generates declare const for enum with labels', () => {
    const enumDef: EnumDefinition = {
      name: 'OrderStatus',
      backing: 'string',
      cases: [
        { key: 'PENDING', value: 'pending', label: 'Pending Order' },
        { key: 'APPROVED', value: 'approved', label: 'Approved' },
      ],
    };

    const result = generateSingleEnumTypeScript(enumDef, 'app/Enums/OrderStatus.php');

    expect(result).toBe(dedent`
      /** @see app/Enums/OrderStatus.php */
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
      //# sourceMappingURL=OrderStatus.d.ts.map
    `);
  });
});

describe('generateSingleEnumRuntime', () => {
  it('generates runtime object for enum with labels', () => {
    const enumDef: EnumDefinition = {
      name: 'OrderStatus',
      backing: 'string',
      cases: [
        { key: 'PENDING', value: 'pending', label: 'Pending Order' },
        { key: 'APPROVED', value: 'approved', label: 'Approved' },
      ],
    };

    const result = generateSingleEnumRuntime(enumDef);

    expect(result).toBe(dedent`
      export const OrderStatus = {
          PENDING: {
              value: "pending",
              label: "Pending Order"
          },
          APPROVED: {
              value: "approved",
              label: "Approved"
          }
      };
    `);
  });

  it('generates runtime object for enum without labels', () => {
    const enumDef: EnumDefinition = {
      name: 'Role',
      backing: 'string',
      cases: [
        { key: 'ADMIN', value: 'admin' },
        { key: 'USER', value: 'user' },
      ],
    };

    const result = generateSingleEnumRuntime(enumDef);

    expect(result).toBe(dedent`
      export const Role = {
          ADMIN: "admin",
          USER: "user"
      };
    `);
  });

  it('generates runtime object for int-backed enum', () => {
    const enumDef: EnumDefinition = {
      name: 'Priority',
      backing: 'int',
      cases: [
        { key: 'LOW', value: 1 },
        { key: 'HIGH', value: 3 },
      ],
    };

    const result = generateSingleEnumRuntime(enumDef);

    expect(result).toBe(dedent`
      export const Priority = {
          LOW: 1,
          HIGH: 3
      };
    `);
  });
});

describe('generateEnumSourceMap', () => {
  it('generates valid source map JSON', () => {
    const enumDef: EnumDefinition = {
      name: 'Role',
      backing: 'string',
      cases: [
        { key: 'ADMIN', value: 'admin', loc: { file: 'app/Enums/Role.php', line: 8 } },
        { key: 'USER', value: 'user', loc: { file: 'app/Enums/Role.php', line: 9 } },
      ],
      loc: { file: 'app/Enums/Role.php', line: 5 },
    };

    const result = generateEnumSourceMap(enumDef, 'Role.d.ts', 'app/Enums/Role.php', '/project/node_modules/@ferry/enums');
    const parsed = JSON.parse(result);

    expect(parsed.version).toBe(3);
    expect(parsed.file).toBe('Role.d.ts');
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0]).toContain('app/Enums/Role.php');
    expect(typeof parsed.mappings).toBe('string');
  });

  it('includes mappings for enum declaration and cases', () => {
    const enumDef: EnumDefinition = {
      name: 'Priority',
      backing: 'int',
      cases: [
        { key: 'LOW', value: 1, loc: { file: 'app/Enums/Priority.php', line: 10 } },
        { key: 'HIGH', value: 3, loc: { file: 'app/Enums/Priority.php', line: 11 } },
      ],
      loc: { file: 'app/Enums/Priority.php', line: 5 },
    };

    const result = generateEnumSourceMap(enumDef, 'Priority.d.ts', 'app/Enums/Priority.php', '/project/node_modules/@ferry/enums');
    const parsed = JSON.parse(result);

    // Should have mappings for declaration + 2 cases = non-empty string
    expect(parsed.mappings.length).toBeGreaterThan(0);
  });

  it('handles enum without loc information', () => {
    const enumDef: EnumDefinition = {
      name: 'Role',
      backing: 'string',
      cases: [
        { key: 'ADMIN', value: 'admin' },
        { key: 'USER', value: 'user' },
      ],
    };

    const result = generateEnumSourceMap(enumDef, 'Role.d.ts', 'app/Enums/Role.php', '/project/node_modules/@ferry/enums');
    const parsed = JSON.parse(result);

    // Should still be valid JSON, just with empty mappings
    expect(parsed.version).toBe(3);
    expect(parsed.file).toBe('Role.d.ts');
  });
});

describe('collectEnums source location', () => {
  it('captures loc property on collected enums', () => {
    const enums = collectEnums(join(fixturesDir, 'Enums'), fixturesDir);

    // All enums should have loc property
    for (const enumName of Object.keys(enums)) {
      const enumDef = enums[enumName];
      expect(enumDef.loc).toBeDefined();
      expect(enumDef.loc!.file).toContain(`Enums/${enumName}.php`);
      expect(enumDef.loc!.line).toBeGreaterThan(0);
    }
  });

  it('captures loc property on enum cases', () => {
    const enums = collectEnums(join(fixturesDir, 'Enums'), fixturesDir);

    for (const enumDef of Object.values(enums)) {
      for (const enumCase of enumDef.cases) {
        expect(enumCase.loc).toBeDefined();
        expect(enumCase.loc!.line).toBeGreaterThan(0);
      }
    }
  });
});
