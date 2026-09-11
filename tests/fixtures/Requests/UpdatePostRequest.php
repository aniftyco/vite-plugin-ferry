<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UpdatePostRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'title' => 'required|string',
            'views' => 'required|integer',
            'published' => 'sometimes|boolean',
        ];
    }
}
