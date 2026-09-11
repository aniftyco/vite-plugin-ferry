<?php

namespace App\Http\Controllers;

use App\Http\Resources\OrderResource;
use App\Http\Resources\PostResource;
use App\Http\Resources\UserResource;
use Inertia\Inertia;

class PartialController extends Controller
{
    public function show($id)
    {
        $user = User::findOrFail($id);

        return Inertia::render('Partials/Show', [
            'user' => fn () => new UserResource($user),
            'orders' => Inertia::defer(fn () => OrderResource::collection($user->orders)),
            'profile' => Inertia::optional(fn () => new UserResource($user)),
            'posts' => Inertia::lazy(fn () => PostResource::collection($user->posts)),
            'stats' => Inertia::merge(fn () => new OrderResource($user->latestOrder)),
        ]);
    }
}
