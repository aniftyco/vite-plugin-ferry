<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;

class DegradingChildResource extends DegradingParentResource
{
    public function toArray(Request $request): array
    {
        return array_merge(parent::toArray($request), [
            'own' => 'x',
        ]);
    }
}
