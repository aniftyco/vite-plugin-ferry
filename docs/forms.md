# Form types

`@ferry/forms` types your `FormRequest` classes. Ferry reads each `rules()` method and generates a data-shape type per request, named by the class's verbatim short name.

A request that declares no `rules()` of its own takes its parent's, following `extends` through your request classes until one declares it. The parent is resolved the way PHP resolves it, through the class's `use` imports (aliases included) or its own namespace, so two requests that share a short name in different namespaces never get mixed up. The parent's `@ferry` pins come with its rules, and a pin on the child overrides the parent's pin for the same field.

## How `rules()` is read

`rules()` can return an array literal, or a variable holding one. For a variable, ferry starts from the array literal first assigned to it and adds every `$rules['key'] = ...` assigned after it, including inside loops and `if` blocks. A key that interpolates a variable, such as `"overrides.$key"` inside a `foreach`, stands for keys known only at runtime, so its parent types as a record:

```php
public function rules(): array
{
    $rules = ['overrides' => ['required', 'array']];

    foreach (array_keys(config('app.caps')) as $key) {
        $rules["overrides.$key"] = ['nullable', 'integer'];
    }

    return $rules;
}
```

```ts
export type UpdateCapsRequest = {
  overrides: Record<string, number | null>;
};
```

A variable built any other way (reassigned, appended to with `$rules[]`, merged with `+=`, keyed by an expression that isn't a string, or first assigned something other than an array literal) can't be read statically.

## The generated shape

Pass the generated type to `useForm<T>()` to type both the form data and, for free, the `form.errors` keys, which Inertia derives from the same shape via its own `FormDataKeys<T>`, including nested (`profile.bio`) and array (`items.0.id`) paths.

```php
// app/Http/Requests/StoreUserRequest.php
public function rules(): array
{
    return [
        'name' => 'required|string',
        'age' => 'nullable|integer',
        'role' => 'required|in:admin,editor,viewer',
        'profile.bio' => ['nullable', 'string'],
        'items.*.id' => ['required', 'integer'],
    ];
}
```

```ts
declare module '@ferry/forms' {
  export type StoreUserRequest = {
    name: string;
    age: number | null;
    role: 'admin' | 'editor' | 'viewer';
    profile: { bio: string | null };
    items: { id: number }[];
  };
}
```

```tsx
// resources/js/Pages/Users/Create.tsx
import type { StoreUserRequest } from '@ferry/forms';

const form = useForm<StoreUserRequest>({ name: '', age: null, role: 'admin', profile: { bio: null }, items: [] });
form.data.role;             // 'admin' | 'editor' | 'viewer'
form.errors['profile.bio']; // typed error key, derived from the shape
form.errors['items.0.id'];  // wildcard array paths resolve too
```

## Rule mapping

Rule tokens map to leaf types:

- `string`, `email`, `url`, `uuid`, `date`, `ip`, `ipv4`, `ipv6`, `mac_address` map to `string`.
- `integer`, `numeric`, `decimal` map to `number`.
- `boolean` and `accepted` map to `boolean`.
- `in:a,b,c` maps to a string-literal union.
- The file rules `file`, `image`, `mimes`, `mimetypes`, `dimensions` map to `File`.
- `array` maps to `any[]` unless nested keys describe its shape.

A `Rule::enum(SomeEnum::class)` field submits the raw backing value, so it types as that enum's `<Enum>Value` [backing-value union](enums.md) (for example `RoleValue`, imported from `@ferry/enums`). String-backed and int-backed both resolve.

Dotted keys nest (`profile.bio` becomes `profile: { bio: ... }`) and a `*` segment becomes an array (`items.*.id` becomes `items: { id: ... }[]`). `nullable` unions `| null` onto the value; `sometimes` makes the key optional; every other field is present, since a form initializes all of them.

## Degrade and pins

A field whose only rule ferry can't map to a type (an unrecognized `Rule::` object, a closure, or a rule with no type signal) degrades to `any`, or `unknown` under [`strict`](configuration.md), with a warning. The same `@ferry <field> <type>` docblock [pin](ferry-pins.md) available on `toArray()` and `share()` works here: a tag in the `FormRequest`'s docblock overrides that field's generated type verbatim and clears its degrade warning.

When ferry can't read a request's `rules()`, `@ferry` pins on the request type it on their own: the generated type holds exactly the pinned fields, and no warning is shown. With no pins, the request types as `Record<string, any>` (`unknown` under `strict`), with a warning.

A form with no matching `FormRequest` generates no type, and its `useForm()` call simply omits the generic.
