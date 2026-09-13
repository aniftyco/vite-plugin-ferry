# Getting started

Install ferry, add it to Vite, and let it generate types from your Laravel app. This page covers requirements, setup, how generation runs, and how the generated modules reach your code.

## Requirements

- Laravel 13+
- TypeScript `^5.0` (peer dependency, used for code generation)
- npm. Ferry writes into the hoisted `node_modules/@types`, so it needs npm's flat `node_modules` layout. pnpm and Yarn PnP aren't supported.
- PHP and a bootable Laravel app in the environment that builds the frontend. Ferry resolves routes and model metadata at build time by shelling out to `php artisan route:list` (routes) and `php artisan tinker` (model metadata), so a Node-only build environment (for example a Docker builder stage without PHP) can't resolve them — routes in particular fail the build loudly.

## Install

```bash
npm install vite-plugin-ferry typescript@^5 --save-dev
```

Add it to your `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import ferry from 'vite-plugin-ferry';

export default defineConfig({
  plugins: [ferry()],
});
```

No tsconfig changes, no generated files to gitignore. Ferry auto-loads its types from `node_modules/@types/vite-plugin-ferry` the moment TypeScript 5.x sees the package installed.

If your `tsconfig.json` sets `compilerOptions.types` (which suppresses TypeScript's automatic `@types/*` inclusion), add the bare package name to the array so ferry's ambient types still load:

```json
{
  "compilerOptions": {
    "types": ["node", "vite-plugin-ferry"]
  }
}
```

## How generation works

Ferry reads your Laravel app under the plugin's [`cwd`](configuration.md): `app/Enums`, `app/Http/Resources`, `app/Models`, `app/Http/Controllers`, `app/Http/Middleware`, `app/Http/Requests`, and `routes`. It runs during dev and on build, and regenerates everything on every run, so the types always match the current backend.

Nothing is written into your project tree. Runtime code is delivered as Vite virtual modules, and types as one generated ambient `.d.ts` that TypeScript picks up through `node_modules/@types/vite-plugin-ferry`. Because the types are ambient, `route()` and its friends resolve in your source with no import wiring on your part.

## The generated modules

Ferry generates six virtual modules. Import runtime values from them like any package, and import types with `import type`:

| Module | What it holds |
| ------ | ------------- |
| `@ferry/route` | The `route()` resolver runtime backing the ambient `route()` helper. See [Routes](routes.md). |
| `@ferry/enum` | The base `Enum` class each generated enum extends. See [Enums](enums.md). |
| `@ferry/enums` | One generated class per PHP enum, plus each enum's `<Enum>Value` backing-value union. See [Enums](enums.md). |
| `@ferry/resources` | A type per `JsonResource` class. See [Resources](resources.md). |
| `@ferry/pages` | A props type per Inertia page. See [Page props](page-props.md). |
| `@ferry/forms` | A data-shape type per `FormRequest`. See [Form types](forms.md). |

```ts
import { OrderStatus } from '@ferry/enums';
import type { PostResource } from '@ferry/resources';
import type { UsersShowProps } from '@ferry/pages';
import type { StoreUserRequest } from '@ferry/forms';
```

For the plugin options, see [Configuration](configuration.md).
