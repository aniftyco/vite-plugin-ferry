# Routes

`@ferry/route` gives you a typed `route()` helper that resolves named Laravel routes to their URL and method in the browser, without shipping the route table.

## The `route()` helper

`route()` is ambient-typed, so no import is needed in your source. Ferry's codemod rewrites the call at build time, swapping the route name for its URI pattern and injecting the resolver import for you.

```php
// routes/web.php
Route::get('/users/{user}', [UserController::class, 'show'])->name('users.show');
```

One call works everywhere. `route()` returns a value that is a plain `string` **and** Inertia's `{ url, method }` pair at once, so the same call drops into `<Link href>`, `router.delete`, a template literal, or anywhere a string is expected — no type argument, no `.url`.

```tsx
const href = route('users.show', { user: 1 });
// build-time codemod rewrites the call to:
route('/users/{user}', { user: 1 }, 'get')
// runtime resolves to a value usable as '/users/1' AND as { url: '/users/1', method: 'get' }

<Link href={route('users.show', { user: 1 })} />       // Link reads { url, method } directly — the HTTP method travels with the value
router.delete(route('users.destroy', { user: 1 }))     // the 'delete' verb rides along, no extra props
`Visit ${route('users.show', { user: 1 })}`            // template literal: '/users/1'
route('users.show', { user: 1 }).startsWith('/users')  // it is a real string, so string methods work
route('users.index', { page: 2 })                       // extra keys become the query string: '/users?page=2'
```

Because the method travels with the value, non-GET links stay ergonomic: passing a `route()` result straight to `<Link>` or `router.*` carries the right HTTP verb into Inertia with no extra props.

## Current-route checks

`route.is()` reports whether a route is the current one, with route-name prefixes validated at compile time. It accepts a single name, a wildcard, or an array of either (matching if the current route is any of them):

```tsx
route.is('users.show', { user: 1 });          // this route, this user
route.is('users.*');                          // any users.* route active (nav highlighting)
route.is(['users.show', 'posts.index']);      // true on either route
route.is(['users.*', 'admin.*']);             // true under either section
```

The array form matches at the name/pattern level only — pass params to the single-name form when you need to match a concrete param.

## Scoped bindings

Laravel scoped bindings are supported. Call the route with the binding name (the part before the colon), not the field:

```php
// routes/web.php
Route::get('posts/{post:slug}/edit', [PostController::class, 'edit'])->scopeBindings()->name('post.edit');
```

```tsx
route('post.edit', { post: 'hello-world' });            // '/posts/hello-world/edit'
route.is('post.edit', { post: 'hello-world' });  // true on /posts/hello-world/edit
```

## What ships to the browser

Only the patterns for routes actually referenced in your code ever reach the browser. The full route table never ships.

## Frontend support

`route()` and `route.is()` resolve through ferry on React, Vue, and Svelte, in dev and production.

## PHP is required in the build environment

Ferry resolves the route table at build time by running `php artisan route:list`, so PHP and a bootable Laravel app must be available wherever the frontend is built. A Node-only environment (for example a Docker builder stage that installs Node but not PHP) returns no routes, and any `route()` or `route.is()` usage then fails the build with a clear error rather than shipping a bundle that references an undefined `route`. Build the frontend where PHP and your Laravel app are present.
