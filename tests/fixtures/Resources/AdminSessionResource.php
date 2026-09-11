<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;

/**
 * @mixin \App\Models\Session
 */
class AdminSessionResource extends SessionResource
{
    public function toArray(Request $request): array
    {
        return array_merge(parent::toArray($request), [
            'is_admin' => true,
        ]);
    }
}
