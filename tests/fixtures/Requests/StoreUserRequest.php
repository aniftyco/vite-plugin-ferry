<?php

namespace App\Http\Requests;

use App\Enums\Priority;
use App\Enums\Role;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreUserRequest extends FormRequest
{
    /**
     * @ferry meta Record<string, string>
     */
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
            'terms' => 'accepted',
            'photo' => ['required', 'image', 'mimes:jpg,png'],
            'attachment' => ['nullable', 'file'],
            'assigned_role' => ['required', Rule::enum(Role::class)],
            'priority' => ['required', Rule::enum(Priority::class)],
            'meta' => ['required', Rule::exists('settings', 'key')],
        ];
    }
}
