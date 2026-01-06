<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class OrderResource extends JsonResource
{
    /**
     * @return array {
     *     id: string,
     *     total: number,
     *     status: string,
     *     items: array,
     *     created_at: string
     * }
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->resource->id,
            'total' => $this->resource->total,
            'status' => $this->resource->status,
            'items' => $this->resource->items,
            'user' => $this->whenLoaded('user'),
            'shipping_address' => [
                'street' => $this->resource->address_street,
                'city' => $this->resource->address_city,
                'zip' => $this->resource->address_zip,
            ],
            'created_at' => $this->resource->created_at,
        ];
    }
}
