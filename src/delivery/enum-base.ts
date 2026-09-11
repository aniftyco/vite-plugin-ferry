/**
 * The concrete base `Enum` class served at `@ferry/enum`. Static and zero-dep, so
 * it ships as real content (not a placeholder). Generated enum subclasses extend it.
 */
export const ENUM_BASE_RUNTIME = `export class Enum {
  constructor(key, value, label) {
    this.key = key;
    this.value = value;
    this.label = label;
    Object.freeze(this);
  }
  is(other) {
    return (other instanceof Enum ? other.value : other) === this.value;
  }
  toString() {
    return String(this.value);
  }
  static from(value) {
    return this.cases().find((c) => c.value === value);
  }
  static fromOrFail(value) {
    const found = this.from(value);
    if (found === undefined) {
      throw new Error(\`\${this.name}: no case for value \${JSON.stringify(value)}\`);
    }
    return found;
  }
  static values() {
    return this.cases().map((c) => c.value);
  }
  static keys() {
    return this.cases().map((c) => c.key);
  }
  static cases() {
    return Object.keys(this).map((k) => this[k]);
  }
  static options() {
    return this.cases().map((c) => ({ value: c.value, label: c.label }));
  }
}
`;

/**
 * The `@ferry/enum` declaration block for the ambient `index.d.ts`. Written as a
 * `declare module` block so it stays script-style (no top-level import/export).
 */
export const ENUM_BASE_DTS = `declare module '@ferry/enum' {
  export class Enum<V = string | number> {
    readonly key: string;
    readonly value: V;
    readonly label: string | undefined;
    constructor(key: string, value: V, label?: string);
    is(other: V | Enum<V>): boolean;
    toString(): string;
    static from(value: unknown): Enum | undefined;
    static fromOrFail(value: unknown): Enum;
    static values(): unknown[];
    static keys(): string[];
    static cases(): Enum[];
    static options(): Array<{ value: unknown; label: string | undefined }>;
  }
}`;
