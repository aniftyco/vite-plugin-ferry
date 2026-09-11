<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * @mixin \App\Models\Account
 *
 * @ferry meta Record<string, string>
 */
class MergedResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return array_merge(parent::toArray($request), [
            'id' => $this->id,
            'name' => $this->resource->name,
            'phone' => 'hidden',
            'meta' => $this->meta,
            'label' => 'active',
        ]);
    }
}
