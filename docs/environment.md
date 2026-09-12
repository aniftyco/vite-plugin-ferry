# Environment variables

Ferry types `import.meta.env` from your app's `VITE_`-prefixed environment variables, so autocomplete and type-checking cover the env keys your frontend reads.

## What it generates

For every `VITE_`-prefixed variable, ferry adds a member to Vite's own `ImportMetaEnv` interface:

```dotenv
# .env
VITE_API_URL=https://api.example.test
VITE_PUSHER_KEY=abc123
```

```ts
import.meta.env.VITE_API_URL; // string
import.meta.env.VITE_PUSHER_KEY; // string
import.meta.env.VITE_UNKNOWN; // type error — not a declared key
```

No import is needed. Ferry emits a top-level `interface ImportMetaEnv` block that declaration-merges with the one `vite/client` already provides, so your keys join the global type automatically.

## Types are always `string`

Every key is typed `readonly VITE_FOO: string`. `import.meta.env` values are strings at runtime — ferry never infers `boolean` or `number` from a value like `true` or `3`, and never narrows to a literal. Parse and coerce in your own code.

## Keys only, never values

Ferry reads only the variable **names**, never their values. The generated types contain your keys typed as `string` and nothing else, so no secret value is ever written into the ambient `.d.ts`.

## How it reads your env

Ferry loads variables through Vite's own env loader with the `VITE_` prefix, honoring your `envDir` setting and the active mode. It reads the same files Vite does — `.env`, `.env.local`, `.env.[mode]`, `.env.[mode].local` — and only `VITE_`-prefixed keys are ever included, so unprefixed secrets are never read. In dev, editing any of those files regenerates the types and triggers a reload.
