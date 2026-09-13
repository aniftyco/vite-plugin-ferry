<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class InvoiceLineItem extends Model
{
    protected $casts = [
        'quantity' => 'decimal:5',
        'billed_on' => 'datetime:Y-m-d',
        'secret_payload' => 'encrypted:array',
        'meta' => '{ label: string; score: number }',
        'secret_note' => 'encrypted',
        'password_digest' => 'hashed',
        'settings_obj' => 'object',
        'tag_list' => 'collection',
        'synced_moment' => 'timestamp',
    ];
}
