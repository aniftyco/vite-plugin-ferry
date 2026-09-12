# Routes

`@ferry/route` gives you a typed `route()` helper that resolves named Laravel routes to their URL and method in the browser, without shipping the route table.

## The `route()` helper

`route()` is ambient-typed, so no import is needed in your source. Ferry's codemod rewrites the call at build time, swapping the route name for its URI pattern and injecting the resolver import for you.

```php
// routes/web.php
Route::get('/users/{user}', [UserController::class, 'show'])->name('users.show');
```

```tsx
const href = route('users.show', { user: 1 });
// build-time codemod rewrites the call to:
route('/users/{user}', { user: 1 }, 'get')
// runtime resolves to: { url: '/users/1', method: 'get' }

<Link href={route('users.show', { user: 1 })} />       // Link reads { url, method } directly
route('users.destroy', { user: 1 })                      // { url, method } for router.delete / form.submit
`Visit ${route('users.show', { user: 1 })}`              // template literal: coerces via toString() to '/users/1'
route<string>('users.show', { user: 1 })                // explicit string: '/users/1'
route('users.index', { page: 2 })                        // extra keys become the query string: '/users?page=2'
```

Any string-typed type argument works the same way. A string literal (`route<'fixed'>(...)`) or a type alias resolving to `string` both return a real `string` and get the `.url` sugar. A non-string type argument (`route<number>(...)`) is a type error.

## Current-route checks

`route.isCurrent()` works the same way, with route-name prefixes validated at compile time:

```tsx
route.isCurrent('users.show', { user: 1 });  // this route, this user
route.isCurrent('users.*');                  // any users.* route active (nav highlighting)
```

## Scoped bindings

Laravel scoped bindings are supported. Call the route with the binding name (the part before the colon), not the field:

```php
// routes/web.php
Route::get('posts/{post:slug}/edit', [PostController::class, 'edit'])->scopeBindings()->name('post.edit');
```

```tsx
route('post.edit', { post: 'hello-world' });            // '/posts/hello-world/edit'
route.isCurrent('post.edit', { post: 'hello-world' });  // true on /posts/hello-world/edit
```

## What ships to the browser

Only the patterns for routes actually referenced in your code ever reach the browser. The full route table never ships.

## Frontend support

`route()` and `route.isCurrent()` resolve through ferry on React, Vue, and Svelte, in dev and production. The `.url` codemod sugar is React and plain-TypeScript only.
