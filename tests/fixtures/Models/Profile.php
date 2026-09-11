<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * @property array{theme: string, notifications: bool} $settings
 * @property array{name?: string, email?: string|null} $author
 * @property array $tags
 */
class Profile extends Model
{
    protected $casts = [
        'settings' => 'array',
        'author' => 'array',
        'tags' => 'array',
    ];
}
