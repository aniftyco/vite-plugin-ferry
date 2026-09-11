<?php

namespace App\Http\Middleware;

use Illuminate\Http\Request;
use Inertia\Middleware;

class BaseSharedData extends Middleware
{
    public function share(Request $request): array
    {
        return array_merge(parent::share($request), [
            'appName' => 'Ferry',
            'version' => $request->header('X-App-Version'),
        ]);
    }
}
