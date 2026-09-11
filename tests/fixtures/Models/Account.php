<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * @property int $id
 * @property string $name
 * @property string $first_name
 * @property string $last_name
 * @property-read string $full_name
 */
class Account extends Model
{
    protected $appends = ['full_name'];

    protected $hidden = ['deleted_at'];

    public function getFullNameAttribute(): string
    {
        return "{$this->first_name} {$this->last_name}";
    }
}
