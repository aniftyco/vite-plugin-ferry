<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class ProfileResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'settings' => $this->resource->settings,
            'prefs' => $this->resource->settings,
            'tags' => $this->resource->tags,
        ];
    }
}
