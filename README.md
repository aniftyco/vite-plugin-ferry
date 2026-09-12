# vite-plugin-ferry

> Type-safe Inertia apps end to end: TypeScript for routes, enums, resources, page props, and form types, generated straight from your Laravel backend.

[![npm version](https://img.shields.io/npm/v/vite-plugin-ferry.svg?style=flat-square)](https://www.npmjs.com/package/vite-plugin-ferry)
[![npm downloads](https://img.shields.io/npm/dt/vite-plugin-ferry.svg?style=flat-square)](https://www.npmjs.com/package/vite-plugin-ferry)
[![License](https://img.shields.io/npm/l/vite-plugin-ferry.svg?style=flat-square)](LICENSE)

Ferry reads your Laravel app and generates TypeScript for the surface your Inertia frontend touches: named routes, PHP enums, `JsonResource` shapes, per-page Inertia props, and `FormRequest` data. Your frontend is typed from the backend that owns the data, so a change to a resource or a rule shows up as a type error where the frontend uses it. Nothing lands in your project tree: runtime code ships as Vite virtual modules, types as one generated ambient `.d.ts`, and everything regenerates on every run.

## Install

```bash
npm install vite-plugin-ferry typescript@^5 --save-dev
```

## Quick start

Add the plugin to `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import ferry from 'vite-plugin-ferry';

export default defineConfig({
  plugins: [ferry()],
});
```

That's it. No tsconfig changes, no generated files to gitignore. See [Getting started](docs/getting-started.md) for how generation runs and how the types load.

Ferry generates six virtual modules you import from directly:

```ts
import { OrderStatus } from '@ferry/enums';        // enum classes
import type { PostResource } from '@ferry/resources'; // resource shapes
import type { UsersShowProps } from '@ferry/pages';   // per-page Inertia props
import type { StoreUserRequest } from '@ferry/forms';  // form data shapes
// @ferry/route and @ferry/enum back route() and the Enum base class
```

The typed surface, in one page component:

```tsx
import type { UsersShowProps } from '@ferry/pages';
import type { StoreUserRequest } from '@ferry/forms';

const page = usePage<UsersShowProps>();
page.props.user;             // UserResource

const href = route('users.show', { user: 1 }); // usable as a string AND as Inertia's { url, method }
route.is('users.*');                            // current-route check: name, wildcard, or an array of either

const form = useForm<StoreUserRequest>({ name: '', role: 'admin' });
form.data.role;              // 'admin' | 'editor' | 'viewer'
form.errors['profile.bio'];  // error keys derived from the shape
```

## What it generates

- **[Routes](docs/routes.md)** (`@ferry/route`): a typed `route()` helper that resolves named routes to their URL and method client-side, with zero route table shipped to the browser.
- **[Enums](docs/enums.md)** (`@ferry/enum`, `@ferry/enums`): PHP enums become real JS classes with `is`/`from`/`fromOrFail`/`values`/`keys`/`cases`/`options`, plus a `<Enum>Value` backing-value union for serialized data.
- **[Resources](docs/resources.md)** (`@ferry/resources`, `@ferry/pagination`): precise types for your `JsonResource` classes from static `toArray()` analysis plus real column and cast metadata, degrading gracefully instead of breaking your build. `Resource::collection()` over a paginator types as the real `{ data, links, meta }` envelope.
- **[Page props](docs/page-props.md)** (`@ferry/pages`): the props each Inertia page receives, typed through `usePage<T>()`, with shared props typed through Inertia's own augmentation.
- **[Form types](docs/forms.md)** (`@ferry/forms`): the data shape of your `FormRequest` classes, typed through `useForm<T>()` with `form.errors` keys derived for free.
- **[Environment variables](docs/environment.md)** (`import.meta.env`): every `VITE_`-prefixed env var typed as `string`, merged into Vite's own `ImportMetaEnv` — keys only, no values, no import.

Any field ferry can't resolve statically degrades instead of breaking the build, and you can [pin](docs/ferry-pins.md) it precisely with a `@ferry` docblock tag.

## Documentation

- [Getting started](docs/getting-started.md): requirements, plugin setup, how generation and type loading work.
- [Routes](docs/routes.md), [Enums](docs/enums.md), [Resources](docs/resources.md), [Page props](docs/page-props.md), [Form types](docs/forms.md), [Environment variables](docs/environment.md): the full reference for each generated surface.
- [Ferry pins](docs/ferry-pins.md): the `@ferry` docblock tag for overriding a generated type.
- [Configuration](docs/configuration.md): the `cwd`, `strict`, and `verbosity` options.

## Contributing

Issues and pull requests are welcome. Run the test suite with `npm test`.

## License

See [LICENSE](LICENSE) for details.
