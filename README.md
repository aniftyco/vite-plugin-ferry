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

#### String-backed enum with labels

When your enum has a `label()` method, Ferry generates a typed constant object:

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

#### String-backed enum without labels

Simple string enums become TypeScript enums:

```php
// app/Enums/Role.php
enum Role: string
{
    case ADMIN = 'admin';
    case USER = 'user';
    case GUEST = 'guest';
}
```

Generates:

```ts
// @ferry/enums
export enum Role {
  ADMIN = 'admin',
  USER = 'user',
  GUEST = 'guest',
}
```

#### Int-backed enum

Integer enums work the same way:

```php
// app/Enums/Priority.php
enum Priority: int
{
    case LOW = 1;
    case MEDIUM = 2;
    case HIGH = 3;
    case URGENT = 4;
}
```

Generates:

```ts
// @ferry/enums
export enum Priority {
  LOW = 1,
  MEDIUM = 2,
  HIGH = 3,
  URGENT = 4,
}
```

#### Unit enum (no backing type)

Unit enums use their case names as values:

```php
// app/Enums/Color.php
enum Color
{
    case RED;
    case GREEN;
    case BLUE;
}
```

Generates:

```ts
// @ferry/enums
export enum Color {
  RED = 'RED',
  GREEN = 'GREEN',
  BLUE = 'BLUE',
}
```

### Resources

#### Basic resource

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
            'is_admin' => $this->resource->is_admin,
            'created_at' => $this->resource->created_at,
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
  is_admin: boolean;
  created_at: string;
};
```

#### Resource with relations

Fields using `whenLoaded()` become optional and resolve to the correct resource type:

```php
// app/Http/Resources/PostResource.php
class PostResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->resource->id,
            'title' => $this->resource->title,
            'slug' => $this->resource->slug,
            'is_published' => $this->resource->is_published,
            'author' => UserResource::make($this->whenLoaded('author')),
            'comments' => CommentResource::collection($this->whenLoaded('comments')),
            'created_at' => $this->resource->created_at,
        ];
    }
}
```

Generates:

```ts
// @ferry/resources
export type PostResource = {
  id: string;
  title: string;
  slug: string;
  is_published: boolean;
  author?: UserResource[];
  comments?: CommentResource[];
  created_at: string;
};
```

#### Resource with nested objects

Inline array structures become typed objects:

```php
// app/Http/Resources/OrderResource.php
class OrderResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->resource->id,
            'total' => $this->resource->total,
            'status' => $this->resource->status,
            'items' => $this->resource->items,
            'user' => $this->whenLoaded('user'),
            'shipping_address' => [
                'street' => $this->resource->address_street,
                'city' => $this->resource->address_city,
                'zip' => $this->resource->address_zip,
            ],
            'created_at' => $this->resource->created_at,
        ];
    }
}
```

Generates:

```ts
// @ferry/resources
export type OrderResource = {
  id: string;
  total: string;
  status: string;
  items: string;
  user?: UserResource;
  shipping_address: { street: string; city: string; zip: string };
  created_at: string;
};
```

## Publishing

To publish a new version:

```bash
npm version patch  # or minor, major
git push --follow-tags
```

This bumps the version, creates a commit and tag, then pushes both to trigger the publish workflow.

## License

See [LICENSE](LICENSE) for details.
