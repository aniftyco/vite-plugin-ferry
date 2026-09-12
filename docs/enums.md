# Enums

`@ferry/enums` turns each PHP enum into a real JS class, and `@ferry/enum` holds the base `Enum` class they all extend. Serialized enum data types as a separate backing-value union.

## Generated classes

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

OrderStatus.PENDING.value;        // 'pending'
OrderStatus.PENDING.label;        // 'Pending Order' (undefined when the PHP enum has no label())
OrderStatus.from('approved');     // OrderStatus.APPROVED, undefined for an unknown value
OrderStatus.fromOrFail('approved'); // OrderStatus.APPROVED, throws for an unknown value
OrderStatus.PENDING.is(order.status); // true when the raw backing value (or a case) matches
OrderStatus.values();             // ['pending', 'approved', 'rejected']
OrderStatus.options();            // [{ value: 'pending', label: 'Pending Order' }, ...]
```

Each case is a real instance of a generated class extending the base `Enum` from `@ferry/enum`, so the class is both a value and a type. Int-backed enums keep their numeric `value`; unbacked enums use the case name as the value. `from()` returns `undefined` for a value with no case; `fromOrFail()` is the throwing variant when you need a guaranteed case. `is()` compares a case against either another case or a raw backing value.

## The `<Enum>Value` backing-value union

Resource data arrives as the raw backing value over JSON, not an instance, so an enum-cast resource field types as the enum's `<Enum>Value` backing-value union (for example `OrderStatusValue`), not the `OrderStatus` class. Compare it against a case with `resource.status === OrderStatus.PENDING.value` or `OrderStatus.PENDING.is(resource.status)`.

The same backing-value union shows up wherever the frontend receives serialized enum data: [resource](resources.md) fields, [form](forms.md) fields with `Rule::enum`, and [`@ferry` pins](ferry-pins.md) that reference an enum. In every case it's auto-imported from `@ferry/enums`.
