<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * @mixin \App\Models\Account
 */
class LoadedResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            // Closure returning an inline array literal -> that shape, keys included.
            'stats' => $this->whenLoaded('author', fn () => [
                'active' => true,
                'label' => 'author',
            ]),

            // Closure returning a related-model scalar attribute -> the attribute's REAL type,
            // resolved through the relation's metadata. name -> string, age -> number (the case
            // a name-based guess would mis-type), a decimal price -> number.
            'author_name' => $this->whenLoaded('author', fn () => $this->author->name),
            'author_age' => $this->whenLoaded('author', fn () => $this->author->age),
            'author_price' => $this->whenLoaded('author', fn () => $this->author->price),

            // Resolution is global — a plain (non-whenLoaded) related attribute resolves too.
            'plain_author_name' => $this->author->name,

            // Closure returning a literal scalar.
            'kind' => $this->whenLoaded('author', fn () => 'user'),

            // Closure with an explicit default -> closure | default.
            'author_or_flag' => $this->whenLoaded('author', fn () => $this->author->name, false),

            // Unresolvable relation (never dumped) -> degrade to any + warning, no guess.
            'ghost' => $this->whenLoaded('ghost', fn () => $this->ghost->title),

            // No closure -> the relation's resource (the #12 behavior), key optional.
            'user' => $this->whenLoaded('user'),
        ];
    }
}
