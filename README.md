# vite-plugin-ferry

> A Vite plugin that ferries your Laravel backend types to the frontend as fully-typed TypeScript.

## What it does

Ferry watches your Laravel application and automatically generates TypeScript definitions so your frontend always stays
in sync with your backend.

- **Enums** — Generates types and runtime constants from `app/Enums/`
- **Resources** — Generates response types from `app/Http/Resources/`

## Installation

```bash
npm install vite-plugin-ferry --save-dev
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
import { UserResource } from '@ferry/resources';
```

## License

See [LICENSE](LICENSE) for details.
