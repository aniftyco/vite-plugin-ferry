# Page props

`@ferry/pages` types the props each Inertia page receives. Ferry reads your controllers, infers each prop with the same resource and enum machinery used elsewhere, and generates a props type per page.

## Per-page props

Ferry reads every `Inertia::render('Users/Show', [...])` across your controllers and infers each prop's type, then generates a props type per page served from `@ferry/pages`. Props whose value is a bare closure or `Inertia::merge(...)` resolve to their real value type and stay required. `Inertia::defer(...)`, `Inertia::optional(...)`, and `Inertia::lazy(...)` resolve to their value type but are typed optional, since they're absent on the initial page load.

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

In a page component, import the generated props type and pass it to `usePage()` explicitly, the same as any shared component:

```tsx
// resources/js/Pages/Users/Show.tsx
import type { UsersShowProps } from '@ferry/pages';

const page = usePage<UsersShowProps>();
page.props.user;        // UserResource
page.props.status;      // OrderStatus
```

### Type-name rule

The props type name comes from the page key: split it on `/`, `\`, `-`, `_`, and spaces, uppercase the first letter of each segment, concatenate, and suffix `Props`.

| Page key            | Props type              |
| ------------------- | ----------------------- |
| `users/show`        | `UsersShowProps`        |
| `account/settings`  | `AccountSettingsProps`  |
| `admin/users/edit`  | `AdminUsersEditProps`   |

Deeper paths add more segments. Only the first letter of each segment is uppercased; interior casing is preserved. So `Users/Show` and `users/show` share `UsersShowProps` because they differ only in first-letter casing, but a segment like `uSeRs` becomes `USeRs` (giving `USeRsShowProps`), not `Users`. Only first-letter casing variants unify, not arbitrary ones. When two keys do share a type name and both are rendered, the type is the union of their shapes.

On a case-sensitive filesystem `Users/Show` and `users/show` are two distinct page components, but ferry treats them as one page under the shared `UsersShowProps` type.

### String-key alternative

Prefer the string form? `PropsFor<K>` maps a render key to its props type through the generated `FerryPageMap`, with autocomplete on the keys:

```tsx
import type { PropsFor } from '@ferry/pages';

const page = usePage<PropsFor<'Users/Show'>>();
page.props.user;        // UserResource
```

The key is the exact string you pass to `Inertia::render(...)`, verbatim, in whatever casing you wrote it. `PropsFor<'Users/Show'>` resolves to the same type as the named `UsersShowProps`.

## Shared props

Shared data from `HandleInertiaRequests::share()` fills Inertia's own `InertiaConfig.sharedPageProps` augmentation and `errorValueType`, so `page.props.auth` and validation errors are typed everywhere without any per-page wiring.

`share()` is read the same way as a resource's `toArray()`: statically-resolvable entries infer directly, and the same `@ferry <prop> <type>` docblock [pin](ferry-pins.md) applies. On `share()` the pin also declares a prop: a conditionally-shared value that never resolves statically, or one not present in the returned array at all, becomes a typed shared prop from the annotation alone.

```php
/**
 * @ferry flash { message?: string }
 * @ferry settings Record<string, string>
 */
public function share(Request $request): array
{
    return array_merge(parent::share($request), [
        'auth' => ['user' => new UserResource($request->user())],
        'settings' => $request->user()->settings(), // ferry can't resolve this -> annotate it
    ]);
}
```

When `share()` calls `parent::share()`, ferry follows it into an app-local base middleware and merges that parent's shared props in too, with the child winning on any key collision. A vendor or otherwise unlocatable parent (such as Inertia's base `Middleware`) is skipped silently.
