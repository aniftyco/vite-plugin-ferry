<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UpdateLimitsRequest extends FormRequest
{
    public function rules(): array
    {
        $rules = [
            'overrides' => ['required', 'array'],
            'note' => ['nullable', 'string'],
        ];

        foreach (array_keys(config('caps')) as $key) {
            $rules["overrides.$key"] = ['nullable', 'integer', 'min:1'];
        }

        $rules['address'] = ['required', 'ip'];

        return $rules;
    }
}
