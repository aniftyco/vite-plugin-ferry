<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreUserRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'name' => 'required|string',
            'email' => 'required|email',
            'age' => 'nullable|integer',
            'bio' => 'sometimes|string',
            'role' => 'required|in:admin,editor,viewer',
            'active' => ['required', 'boolean'],
            'profile' => ['required', 'array'],
            'profile.bio' => ['nullable', 'string'],
            'items' => ['required', 'array'],
            'items.*.id' => ['required', 'integer'],
            'items.*.label' => ['nullable', 'string'],
            'tags' => ['sometimes', 'array'],
            'avatar' => ['required', Rule::exists('files', 'id')],
            'callback' => ['required', function ($attribute, $value, $fail) {
                $fail('invalid');
            }],
        ];
    }
}
