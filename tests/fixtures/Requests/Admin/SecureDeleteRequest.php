<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class SecureDeleteRequest extends FormRequest
{
    /**
     * @ferry scope 'all' | 'mine'
     * @ferry confirm true
     */
    public function rules(): array
    {
        return [
            'password' => ['required', 'string', 'current_password'],
            'scope' => ['required', Rule::in(['all', 'mine'])],
            'confirm' => ['required', Rule::in([true])],
        ];
    }
}
