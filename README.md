# vite-plugin-ferry

> A Vite plugin that ferries your Laravel backend types to the frontend as fully-typed TypeScript.

## What it does

Ferry watches your Laravel application and automatically generates TypeScript definitions so your frontend always stays
in sync with your backend.

- **Enums** — Generates types and runtime constants from `app/Enums/`
- **Resources** — Generates response types from `app/Http/Resources/`

## Requirements

- **TypeScript ^5.0** — Required as a peer dependency for code generation

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

## Usage

Import your backend types directly in your frontend code:

```ts
import { OrderStatus } from '@ferry/enums';
import type { UserResource } from '@ferry/resources';
```

## Examples

### Enums

A PHP enum with labels:

```php
// app/Enums/OrderStatus.php
enum OrderStatus: string
{
    case Pending = 'pending';
    case Shipped = 'shipped';
    case Delivered = 'delivered';

    public function label(): string
    {
        return match ($this) {
            self::Pending => 'Pending Order',
            self::Shipped => 'Shipped',
            self::Delivered => 'Delivered',
        };
    }
}
```

Generates:

```ts
// @ferry/enums
export declare const OrderStatus: {
  Pending: { value: 'pending'; label: 'Pending Order' };
  Shipped: { value: 'shipped'; label: 'Shipped' };
  Delivered: { value: 'delivered'; label: 'Delivered' };
};
```

### Resources

A Laravel JsonResource:

```php
// app/Http/Resources/UserResource.php
class UserResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->resource->id,
            'name' => $this->resource->name,
            'email' => $this->resource->email,
            'created_at' => $this->resource->created_at,
            'posts' => PostResource::collection($this->whenLoaded('posts')),
        ];
    }
}
```

Generates:

```ts
// @ferry/resources
export type UserResource = {
  id: string;
  name: string;
  email: string;
  created_at: string;
  posts?: PostResource[];
};
```

## License

See [LICENSE](LICENSE) for details.
