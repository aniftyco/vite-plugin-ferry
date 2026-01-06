<?php

namespace App\Models;

use App\Enums\OrderStatus;
use Illuminate\Database\Eloquent\Model;

class Order extends Model
{
    protected $casts = [
        'status' => OrderStatus::class,
        'total' => 'decimal',
        'items' => 'json',
        'shipped_at' => 'datetime',
        'is_gift' => 'boolean',
    ];
}
