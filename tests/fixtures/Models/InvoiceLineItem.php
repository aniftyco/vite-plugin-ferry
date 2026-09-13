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
    ];
}
