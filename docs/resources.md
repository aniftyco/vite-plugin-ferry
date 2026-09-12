# Resources

`@ferry/resources` types your `JsonResource` classes. Ferry reads each `toArray()` statically and combines that shape with real column and cast metadata from your models, so the type matches the JSON the resource actually returns.

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

## How the shape is built

Key set and optionality come from static analysis of `toArray()`.

### Attribute reads and conditional helpers

Attribute reads (`$this->prop` and `$this->resource->prop`), `whenHas`, `whenNotNull` (with `| null` stripped), and `whenNull` resolve to the model attribute's type. `whenCounted` and `whenAggregated` resolve to `number`, and `whenExistsLoaded` to `boolean`.

`when()`, `unless()`, and `whenLoaded()` fields become optional. With an explicit default the key stays present and types as `value | default`.

### Relations

A bare `whenLoaded('rel')` types by the relation's resource. A `whenLoaded('rel', fn () => ...)` closure types by what the closure returns instead: an inline array literal keeps its keys, and a scalar stays that scalar. A related model's attribute (`$this->author->name`, whether in a closure or as a plain field) resolves to that model's real column or cast type through the schema dump, degrading to a `@ferry` warning when the relation or attribute can't be resolved rather than guessing.

### Nested resources and merges

`Resource::make()` and `new Resource()` resolve to a single nested type (`| null` when the source column is nullable), `Resource::collection()` to an array, and `mergeWhen()` lifts an inline literal's keys in as optional. Literals and simple computed scalars (strings, numbers, booleans, concatenation, inline arrays) infer directly.

## Leaf types

Leaf types (nullability, casts, enum casts) come from a Laravel schema and casts dump. A nullable enum-cast column types as `OrderStatusValue | null` (the enum's [backing-value union](enums.md)), and an `integer` cast types as `number`.

An `array`, `json`, or `collection` cast types as `any[]` unless the model documents the field with a class-level `@property array{...}` docblock, in which case ferry emits that object shape instead, carrying through its optional keys (`name?: string`) and union values (`string | null`).

The backing model is the resource's `@mixin` when present, otherwise the class name with the `Resource` suffix dropped.

## Merging a parent shape

When `toArray()` is `array_merge(parent::toArray($request), [...inline keys])`, the inline keys resolve as above and the parent contribution is resolved too.

A resource that `extends JsonResource` seeds its `@mixin` model's serialized shape: every column minus `$hidden` (restricted to `$visible` when the model sets one), plus each `$appends` accessor typed from the model's scalar `@property` docblock.

A resource that `extends` another app-local resource inherits that parent resource's own computed `toArray` shape instead: its keys, its pins, its own chain.

Inline keys override parent keys on collision, and a `@ferry` pin still wins over both.

## When a field can't be resolved

A field ferry can't resolve statically degrades instead of breaking your build. The fallback type is controlled by the [`strict`](configuration.md) option, and ferry reports a warning naming the resource and field. Pin any field precisely with a `@ferry` docblock tag on `toArray()`:

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

See [Ferry pins](ferry-pins.md) for the full pin syntax, including how a pin that references an enum resolves to that enum's backing-value union.
