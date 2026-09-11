<?php

namespace App\Http\Resources;

use App\Http\Resources\Nested\NestedSessionResource;
use Illuminate\Http\Request;

/**
 * @mixin \App\Models\Session
 */
class NestedChildResource extends NestedSessionResource
{
    public function toArray(Request $request): array
    {
        return array_merge(parent::toArray($request), [
            'is_admin' => true,
        ]);
    }
}
