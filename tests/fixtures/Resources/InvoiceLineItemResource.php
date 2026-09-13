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
            'secret_note' => $this->resource->secret_note,
            'password_digest' => $this->resource->password_digest,
            'settings_obj' => $this->resource->settings_obj,
            'tag_list' => $this->resource->tag_list,
            'synced_moment' => $this->resource->synced_moment,
        ];
    }
}
