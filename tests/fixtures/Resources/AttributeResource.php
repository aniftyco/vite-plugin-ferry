<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * @mixin \App\Models\Account
 */
class AttributeResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            // Bare $this->prop (proxied to the model) and the explicit $this->resource->prop.
            'id' => $this->id,
            'name' => $this->resource->name,
            'joined_at' => $this->joined_at,

            // Conditional-attribute helpers keyed off model attributes.
            'phone' => $this->whenHas('phone'),
            'mobile' => $this->whenNotNull($this->phone),
            'deleted' => $this->whenNull($this->deleted_at),

            // Aggregates and existence checks.
            'posts_count' => $this->whenCounted('posts'),
            'orders_sum' => $this->whenAggregated('orders'),
            'has_avatar' => $this->whenExistsLoaded('avatar'),

            // Literals and simple computed scalars.
            'label' => 'active',
            'answer' => 42,
            'flag' => true,
            'full_name' => $this->first_name . ' ' . $this->last_name,
            'tags' => ['a', 'b'],

            // when()/unless(): no default -> optional; explicit default -> present union.
            'nickname' => $this->when($request->user(), $this->name),
            'visibility' => $this->when($request->user(), $this->score, 'hidden'),
            'label_or_score' => $this->when($request->user(), $this->name, $this->score),
            'combined_name' => $this->when($request->user(), $this->first_name, $this->last_name),
            'contact' => $this->when($request->user(), $this->phone, $this->name),
            'archived' => $this->unless($request->user(), $this->deleted_at),
        ];
    }
}
