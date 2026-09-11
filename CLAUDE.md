# vite-plugin-ferry

`@aniftyco/vite-plugin-ferry` — a Vite plugin that ferries Laravel types to a TypeScript (Inertia) frontend, generating typed routes, enums, resources, and page props from the backend.

## Inertia accuracy

We target Inertia v2 (`@inertiajs/core` `^3.7.x`, per `package.json`). When generating or parsing anything Inertia-specific — prop helpers like `Inertia::defer`, `Inertia::optional`, `Inertia::merge`, `Inertia::lazy` (the deprecated v1 alias of `optional`), deferred/lazy prop semantics, or the `usePage` PageProps augmentation — match the behavior of the version we support.

Verify helper semantics against that version rather than assuming. When a helper's presence or optionality matters, model the real runtime behavior: deferred props are absent on initial load, so type them optional.
