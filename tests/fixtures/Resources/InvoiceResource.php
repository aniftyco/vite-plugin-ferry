<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class InvoiceResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->resource->id,
            ...[
                'currency' => $this->resource->currency,
                'subtotal' => $this->resource->subtotal,
            ],
            $this->mergeWhen($request->user(), [
                'internal_note' => $this->resource->internal_note,
                'reviewed_by' => $this->resource->reviewed_by,
            ]),
            'number' => $this->resource->number,
        ];
    }
}
