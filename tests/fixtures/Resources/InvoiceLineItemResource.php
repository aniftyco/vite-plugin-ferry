<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class InvoiceLineItemResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'quantity' => $this->resource->quantity,
            'billed_on' => $this->resource->billed_on,
            'secret_payload' => $this->resource->secret_payload,
            'meta' => $this->resource->meta,
        ];
    }
}
