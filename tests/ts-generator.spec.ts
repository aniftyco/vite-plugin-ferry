import { describe, it, expect } from 'vitest';
import {
  printNode,
  printNodes,
  createStringLiteral,
  createNumericLiteral,
  createEnum,
  createObjectLiteral,
  createConstObject,
  createTypeAlias,
  createTypeLiteral,
  createImportType,
  parseTypeString,
  createExportDefault,
} from '../src/utils/ts-generator.js';
import { dedent } from './utils.js';

describe('printNode', () => {
  it('prints a string literal', () => {
    const node = createStringLiteral('hello');
    expect(printNode(node)).toBe('"hello"');
  });

  it('prints a numeric literal', () => {
    const node = createNumericLiteral(42);
    expect(printNode(node)).toBe('42');
  });
});

describe('printNodes', () => {
  it('joins multiple nodes with blank lines', () => {
    const nodes = [createStringLiteral('a'), createStringLiteral('b')];
    expect(printNodes(nodes)).toBe('"a"\n\n"b"');
  });
});

describe('createEnum', () => {
  it('creates string enum declaration', () => {
    const node = createEnum('Role', [
      { key: 'ADMIN', value: 'admin' },
      { key: 'USER', value: 'user' },
    ]);

    expect(printNode(node)).toBe(
      dedent`
        export enum Role {
            ADMIN = "admin",
            USER = "user"
        }
      `.trimEnd()
    );
  });

  it('creates numeric enum declaration', () => {
    const node = createEnum('Priority', [
      { key: 'LOW', value: 1 },
      { key: 'HIGH', value: 3 },
    ]);

    expect(printNode(node)).toBe(
      dedent`
        export enum Priority {
            LOW = 1,
            HIGH = 3
        }
      `.trimEnd()
    );
  });
});

describe('createObjectLiteral', () => {
  it('creates multi-line object literal when multiLine is true', () => {
    const node = createObjectLiteral(
      [
        { key: 'value', value: createStringLiteral('pending') },
        { key: 'label', value: createStringLiteral('Pending Order') },
      ],
      true
    );

    expect(printNode(node)).toBe(
      dedent`
        {
            value: "pending",
            label: "Pending Order"
        }
      `.trimEnd()
    );
  });

  it('creates single-line object literal when multiLine is false', () => {
    const node = createObjectLiteral(
      [
        { key: 'value', value: createStringLiteral('pending') },
        { key: 'label', value: createStringLiteral('Pending Order') },
      ],
      false
    );

    expect(printNode(node)).toBe('{ value: "pending", label: "Pending Order" }');
  });

  it('defaults to multi-line', () => {
    const node = createObjectLiteral([{ key: 'foo', value: createStringLiteral('bar') }]);

    expect(printNode(node)).toBe(
      dedent`
        {
            foo: "bar"
        }
      `.trimEnd()
    );
  });
});

describe('createConstObject', () => {
  it('creates exported const with object literal', () => {
    const node = createConstObject('Config', [
      { key: 'name', value: createStringLiteral('app') },
      { key: 'version', value: createNumericLiteral(1) },
    ]);

    expect(printNode(node)).toBe(
      dedent`
        export const Config = {
            name: "app",
            version: 1
        };
      `.trimEnd()
    );
  });

  it('respects multiLine parameter', () => {
    const node = createConstObject(
      'Config',
      [
        { key: 'a', value: createStringLiteral('1') },
        { key: 'b', value: createStringLiteral('2') },
      ],
      false
    );

    expect(printNode(node)).toBe('export const Config = { a: "1", b: "2" };');
  });
});

describe('createTypeAlias', () => {
  it('creates type alias with type literal', () => {
    const typeLiteral = createTypeLiteral([
      { name: 'id', type: parseTypeString('string') },
      { name: 'name', type: parseTypeString('string') },
    ]);
    const node = createTypeAlias('User', typeLiteral);

    expect(printNode(node)).toBe(
      dedent`
        export type User = {
            id: string;
            name: string;
        };
      `.trimEnd()
    );
  });

  it('handles optional properties', () => {
    const typeLiteral = createTypeLiteral([
      { name: 'id', type: parseTypeString('string') },
      { name: 'email', type: parseTypeString('string'), optional: true },
    ]);
    const node = createTypeAlias('User', typeLiteral);

    expect(printNode(node)).toBe(
      dedent`
        export type User = {
            id: string;
            email?: string;
        };
      `.trimEnd()
    );
  });
});

describe('createImportType', () => {
  it('creates type-only import declaration', () => {
    const node = createImportType(['UserResource', 'PostResource'], '@app/resources');

    expect(printNode(node)).toBe('import type { UserResource, PostResource } from "@app/resources";');
  });

  it('creates single type import', () => {
    const node = createImportType(['OrderStatus'], '@app/enums');

    expect(printNode(node)).toBe('import type { OrderStatus } from "@app/enums";');
  });
});

describe('parseTypeString', () => {
  it('parses primitive types', () => {
    expect(printNode(parseTypeString('string'))).toBe('string');
    expect(printNode(parseTypeString('number'))).toBe('number');
    expect(printNode(parseTypeString('boolean'))).toBe('boolean');
    expect(printNode(parseTypeString('any'))).toBe('any');
    expect(printNode(parseTypeString('null'))).toBe('null');
    expect(printNode(parseTypeString('undefined'))).toBe('undefined');
  });

  it('parses array types', () => {
    expect(printNode(parseTypeString('string[]'))).toBe('string[]');
    expect(printNode(parseTypeString('User[]'))).toBe('User[]');
  });

  it('parses union types', () => {
    expect(printNode(parseTypeString('string | null'))).toBe('string | null');
    expect(printNode(parseTypeString('string | number | boolean'))).toBe('string | number | boolean');
  });

  it('parses Record types', () => {
    expect(printNode(parseTypeString('Record<string, any>'))).toBe('Record<string, any>');
    expect(printNode(parseTypeString('Record<string, number>'))).toBe('Record<string, number>');
  });

  it('parses inline object types', () => {
    const result = printNode(parseTypeString('{ id: string; name: string }'));
    expect(result).toContain('id: string');
    expect(result).toContain('name: string');
  });

  it('parses custom type references', () => {
    expect(printNode(parseTypeString('UserResource'))).toBe('UserResource');
    expect(printNode(parseTypeString('OrderStatus'))).toBe('OrderStatus');
  });
});

describe('createExportDefault', () => {
  it('creates export default statement', () => {
    const node = createExportDefault(createObjectLiteral([], false));
    expect(printNode(node)).toBe('export default {};');
  });
});
