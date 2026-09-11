<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;

/**
 * @mixin \App\Models\Session
 *
 * @ferry agent number
 */
class SuperAdminSessionResource extends AdminSessionResource
{
    public function toArray(Request $request): array
    {
        return array_merge(parent::toArray($request), [
            'level' => 'super',
        ]);
    }
}
