# vite-plugin-ferry

> Type-safe Inertia apps end to end — generates TypeScript for routes, enums, resources, and page props straight from your Laravel backend.

[![npm version](https://img.shields.io/npm/v/vite-plugin-ferry.svg?style=flat-square)](https://www.npmjs.com/package/vite-plugin-ferry)
[![npm downloads](https://img.shields.io/npm/dt/vite-plugin-ferry.svg?style=flat-square)](https://www.npmjs.com/package/vite-plugin-ferry)
[![License](https://img.shields.io/npm/l/vite-plugin-ferry.svg?style=flat-square)](LICENSE)

## Features

- 🧭 **Routes** — a fully typed `route()` helper resolving named routes to their URL and method client-side, with zero route table shipped to the browser
- 🏷️ **Enums** — PHP enums become real JS classes with `is`/`from`/`values`/`keys`/`cases`/`options`, narrowed to their literal value union
- 📦 **Resources** — precise types for your `JsonResource` classes from static shape analysis plus real column/cast metadata, degrading gracefully instead of breaking your build
- 🧩 **Page props** — the props an Inertia page receives, typed through `usePage<T>()` and Inertia's own `sharedPageProps` augmentation
- ⚛️ **React, Vue & Svelte** — `route()` and `route.isCurrent()` resolve through ferry on every frontend, in dev and production (the `.url` codemod sugar is React/plain-TS only)

Nothing is written into your project tree. Runtime code is delivered as Vite virtual modules, types as one generated ambient `.d.ts`, and everything regenerates on every run.

## Requirements

- Laravel 13+
- TypeScript `^5.0` (peer dependency, used for code generation)
- npm — Ferry writes into the hoisted `node_modules/@types`. Supported on npm's flat `node_modules` layout; pnpm and Yarn PnP aren't supported

## Installation

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

That's it — no tsconfig changes, no generated files to gitignore. Ferry auto-loads its types from `node_modules/@types/vite-plugin-ferry` the moment TypeScript 5.x sees the package installed.

If your `tsconfig.json` sets `compilerOptions.types` (which suppresses TypeScript's automatic `@types/*` inclusion), add the bare package name to the array so ferry's ambient types still load:

```json
{
  "compilerOptions": {
    "types": ["node", "vite-plugin-ferry"]
  }
}
```

## Usage

### Routes — `@ferry/route`

`route()` is ambient-typed — no import needed in your source. Ferry's codemod rewrites the call at build time, swapping the route name for its URI pattern and injecting the resolver import for you.

```php
// routes/web.php
Route::get('/users/{user}', [UserController::class, 'show'])->name('users.show');
```

```tsx
const href = route('users.show', { user: 1 });
// build-time codemod rewrites the call to:
route('/users/{user}', { user: 1 }, 'get')
// runtime resolves to: { url: '/users/1', method: 'get' }

<Link href={route('users.show', { user: 1 })} />       // Link reads { url, method } directly
route('users.destroy', { user: 1 })                      // { url, method } for router.delete / form.submit
`Visit ${route('users.show', { user: 1 })}`              // template literal: coerces via toString() to '/users/1'
route<string>('users.show', { user: 1 })                // explicit string: '/users/1'
route('users.index', { page: 2 })                        // extra keys become the query string: '/users?page=2'
```

Any string-typed type argument works the same way — a string literal (`route<'fixed'>(...)`) or a type alias resolving to `string` all return a real `string` and get the `.url` sugar; a non-string type argument (`route<number>(...)`) is a type error.

Current-route checks work the same way, with route-name prefixes validated at compile time:

```tsx
route.isCurrent('users.show', { user: 1 });  // this route, this user
route.isCurrent('users.*');                  // any users.* route active (nav highlighting)
```

Only the patterns for routes actually referenced in your code ever reach the browser — the full route table never ships.

### Enums — `@ferry/enum`, `@ferry/enums`

```php
// app/Enums/OrderStatus.php
enum OrderStatus: string
{
    case PENDING = 'pending';
    case APPROVED = 'approved';
    case REJECTED = 'rejected';

    public function label(): string
    {
        return match ($this) {
            self::PENDING => 'Pending Order',
            self::APPROVED => 'Approved',
            self::REJECTED => 'Rejected',
        };
    }
}
```

```ts
import { OrderStatus } from '@ferry/enums';

export class OrderStatus extends Enum {
  static PENDING = new OrderStatus('PENDING', 'pending', 'Pending Order');
  static APPROVED = new OrderStatus('APPROVED', 'approved', 'Approved');
  static REJECTED = new OrderStatus('REJECTED', 'rejected', 'Rejected');
}

OrderStatus.PENDING.value;     // 'pending'
OrderStatus.PENDING.label;     // 'Pending Order' (undefined when the PHP enum has no label())
OrderStatus.from('approved');  // OrderStatus.APPROVED
OrderStatus.PENDING.is(order.status); // instance equality by value
OrderStatus.values();          // ['pending', 'approved', 'rejected']
OrderStatus.options();         // [{ value: 'pending', label: 'Pending Order' }, ...]
```

Each case is a real instance of a generated class extending the base `Enum` from `@ferry/enum` — a class is both a value and a type, so `status: OrderStatus` just works. Int-backed enums keep their numeric `value`; unbacked enums use the case name as the value.

### Resources — `@ferry/resources`

```php
// app/Http/Resources/PostResource.php
class PostResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'title' => $this->title,
            'author' => UserResource::make($this->whenLoaded('author')),
            'comments' => CommentResource::collection($this->whenLoaded('comments')),
        ];
    }
}
```

```ts
declare module '@ferry/resources' {
  export type PostResource = {
    id: number;
    title: string;
    author?: UserResource;
    comments?: CommentResource[];
  };
}
```

```ts
import type { PostResource } from '@ferry/resources';
```

Key set and optionality come from static analysis of `toArray()` — `when()`/`whenLoaded()` fields become optional, `Resource::make()` resolves to a single nested type, `Resource::collection()` to an array. Leaf types (nullability, casts, enum casts) come from a Laravel schema/casts dump, so a nullable enum-cast column types as `OrderStatus | null` and an `integer` cast types as `number`.

A field ferry can't resolve statically degrades instead of breaking your build — controlled by the [`strict`](#configuration) option — and reports a warning naming the resource and field. Pin any field precisely with a `@ferry` docblock tag on `toArray()`:

```php
/**
 * @ferry meta Record<string, string>
 */
public function toArray(Request $request): array
{
    return [
        'meta' => $this->buildMeta(), // ferry can't resolve this -> warns -> annotate it
    ];
}
```

### Page props — `@ferry/pages`

Ferry reads every `Inertia::render('Users/Show', [...])` across your controllers and infers each prop's type using the same resource/enum machinery, then generates a props type per page served from `@ferry/pages`.

```php
// app/Http/Controllers/UserController.php
public function show(User $user)
{
    return Inertia::render('Users/Show', [
        'user' => new UserResource($user),
        'status' => $user->status,
    ]);
}
```

In a page component, import the generated props type and pass it to `usePage()` explicitly — the same as any shared component:

```tsx
// resources/js/Pages/Users/Show.tsx
import type { UsersShowProps } from '@ferry/pages';

const page = usePage<UsersShowProps>();
page.props.user;        // UserResource
page.props.status;      // OrderStatus
```

Shared data from `HandleInertiaRequests::share()` fills Inertia's own `InertiaConfig.sharedPageProps` augmentation and `errorValueType`, so `page.props.auth` and validation errors are typed everywhere without any per-page wiring.

## Configuration

```ts
ferry({
  cwd: process.cwd(),
  strict: false,
})
```

| Option   | Type      | Default          | Description                                                                                                    |
| -------- | --------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `cwd`    | `string`  | `process.cwd()`  | Root of the Laravel app ferry reads from (`app/Enums`, `app/Http/Resources`, `routes`, etc.)                     |
| `strict` | `boolean` | `false`          | Fallback type for a field ferry can't resolve statically. `false` → `any` (never breaks a typecheck); `true` → `unknown` (forces the consumer to narrow) |

## Testing

```bash
npm test
```

## Contributing

Issues and pull requests are welcome.

## License

See [LICENSE](LICENSE) for details.
