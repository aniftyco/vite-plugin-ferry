<?php

namespace App\Enums;

enum OrderStatus: string
{
    case PENDING = 'pending';
    case APPROVED = 'approved';
    case REJECTED = 'rejected';
    case SHIPPED = 'shipped';

    public function getLabel(): string
    {
        return match($this) {
            self::PENDING => 'Pending Order',
            self::APPROVED => 'Approved',
            self::REJECTED => 'Rejected',
            self::SHIPPED => 'Shipped',
        };
    }
}
