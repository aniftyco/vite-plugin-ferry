# Ferry pins

When ferry can't resolve a field statically, it degrades the type and warns. A `@ferry` docblock tag pins that field to a type you write, overriding what ferry would infer.

## Syntax

A pin is a docblock tag of the form `@ferry <field> <type>`. The `<type>` is emitted verbatim into the generated output:

```php
/**
 * @ferry meta Record<string, string>
 */
public function toArray(Request $request): array
{
    return [
        'meta' => $this->buildMeta(),
    ];
}
```

## Where pins apply

Pins work in three places, all read the same way:

- **Resources**, on the `toArray()` docblock. See [Resources](resources.md).
- **FormRequests**, on the class docblock. See [Form types](forms.md).
- **Controller actions and `share()`**, on the method docblock. See [Page props](page-props.md).

A pin wins verbatim over anything ferry would infer for that field, and it clears the field's degrade warning. On `share()`, a pin also declares a shared prop: a value that never resolves statically, or one absent from the returned array entirely, becomes a typed shared prop from the annotation alone.

## Referencing an enum

A pin describes the JSON the frontend receives, and a serialized enum is always its backing value. So a pin that references a generated enum, either the bare enum name (`OrderStatus`) or its explicit backing-value form (`OrderStatusValue`), resolves to that enum's [backing-value union](enums.md) and is imported from `@ferry/enums` automatically.

A quoted string-literal type (`'OrderStatus'`) is left alone: it stays a string literal rather than resolving to the enum. This resolution applies to pins on resources, `FormRequest`s, and controller actions or `share()` alike.
