<?php

namespace App\Http\Middleware;

use App\Http\Resources\UserResource;
use Illuminate\Http\Request;
use Inertia\Middleware;

class HandleInertiaRequests extends Middleware
{
    /**
     * @ferry flash { message: string }
     * @ferry settings Record<string, string>
     */
    public function share(Request $request): array
    {
        return array_merge(parent::share($request), [
            'auth' => [
                'user' => new UserResource($request->user()),
            ],
            'settings' => $request->user()->settings(),
        ]);
    }
}
