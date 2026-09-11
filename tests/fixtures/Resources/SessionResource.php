<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * Computed keys that are NOT columns on the Session model — resolved by pins, not metadata.
 *
 * @ferry agent string
 * @ferry location string
 */
class SessionResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'agent' => $this->userAgent(),
            'location' => $this->resolveLocation(),
        ];
    }
}
