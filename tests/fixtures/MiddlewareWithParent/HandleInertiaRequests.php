<?php

namespace App\Http\Middleware;

use App\Http\Resources\UserResource;
use Illuminate\Http\Request;

class HandleInertiaRequests extends BaseSharedData
{
    public function share(Request $request): array
    {
        return array_merge(parent::share($request), [
            'auth' => [
                'user' => new UserResource($request->user()),
            ],
            'version' => 2,
        ]);
    }
}
