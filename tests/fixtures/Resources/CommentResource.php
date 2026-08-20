<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class CommentResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->resource->id,
            'body' => $this->resource->body,
            'is_approved' => $this->resource->is_approved,
            'created_at' => $this->resource->created_at,
        ];
    }
}
