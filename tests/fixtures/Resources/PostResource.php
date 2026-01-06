<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class PostResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->resource->id,
            'title' => $this->resource->title,
            'slug' => $this->resource->slug,
            'is_published' => $this->resource->is_published,
            'has_comments' => $this->resource->has_comments,
            'author' => UserResource::make($this->whenLoaded('author')),
            'comments' => CommentResource::collection($this->whenLoaded('comments')),
            'top_voted_comment' => new CommentResource($this->whenLoaded('topVotedComment')),
            'created_at' => $this->resource->created_at,
        ];
    }
}
