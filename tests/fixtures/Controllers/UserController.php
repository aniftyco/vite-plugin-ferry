<?php

namespace App\Http\Controllers;

use App\Enums\OrderStatus;
use App\Http\Resources\OrderResource;
use App\Http\Resources\UserResource;
use Inertia\Inertia;

class UserController extends Controller
{
    public function show($id)
    {
        $user = User::findOrFail($id);
        $orders = $user->orders;

        return Inertia::render('Users/Show', [
            'user' => new UserResource($user),
            'orders' => OrderResource::collection($orders),
            'status' => OrderStatus::PENDING,
            'title' => 'User detail',
        ]);
    }
}
