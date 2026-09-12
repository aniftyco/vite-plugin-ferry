# Configuration

Ferry takes three options, all optional. Defaults suit most Laravel apps, so `ferry()` with no arguments works out of the box.

```ts
ferry({
  cwd: process.cwd(),
  strict: false,
  verbosity: 'info',
})
```

| Option      | Type                                        | Default            | Description |
| ----------- | ------------------------------------------- | ------------------ | ----------- |
| `cwd`       | `string`                                    | `process.cwd()`    | Root of the Laravel app ferry reads from (`app/Enums`, `app/Http/Resources`, `routes`, and so on). |
| `strict`    | `boolean`                                   | `false`            | Fallback type for a field ferry can't resolve statically. `false` uses `any` (never breaks a typecheck); `true` uses `unknown` (forces the consumer to narrow). |
| `verbosity` | `'silent' \| 'error' \| 'warn' \| 'info'`   | vite's `logLevel`  | How much ferry logs. See below. |

## Strict mode

When ferry can't resolve a field statically, it degrades to a fallback type instead of breaking your build. `strict` picks that fallback:

- `false` (default): the field types as `any`, which never breaks a typecheck.
- `true`: the field types as `unknown`, forcing the consumer to narrow before using it.

Either way, ferry reports a warning naming what it couldn't resolve, and a [`@ferry` pin](ferry-pins.md) overrides the fallback with a type you write and clears the warning.

## Verbosity

Verbosity is ordered by severity: `silent` < `error` < `warn` < `info`. A message prints only when its severity is at or below this level. `error` shows only errors, `warn` adds warnings, `info` shows everything, and `silent` shows nothing. When unset, ferry inherits vite's own `logLevel`, falling back to `info`.

Build-failing errors always abort the build regardless of this setting.
