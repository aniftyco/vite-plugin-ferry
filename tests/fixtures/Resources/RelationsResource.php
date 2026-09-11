<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * @mixin \App\Models\Account
 */
class RelationsResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            // new/make over a nullable source column -> Resource | null.
            'owner' => new UserResource($this->resource->phone),
            // new/make over a non-nullable source column -> Resource.
            'manager' => UserResource::make($this->name),
            // whenLoaded wrapped in a resource -> optional resource / collection.
            'author' => UserResource::make($this->whenLoaded('author')),
            'comments' => CommentResource::collection($this->whenLoaded('comments')),
        ];
    }
}
