<?php

namespace App\Http\Resources\Nested;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * A parent resource living in a subdirectory — its computed keys are NOT Session columns.
 *
 * @ferry agent string
 * @ferry location string
 */
class NestedSessionResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'agent' => $this->userAgent(),
            'location' => $this->resolveLocation(),
        ];
    }
}
