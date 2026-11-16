<?php

namespace App\Http\Requests;

use App\Http\Requests\Admin\SecureDeleteRequest;

/**
 * @ferry confirm boolean
 */
class DeletePostRequest extends SecureDeleteRequest
{
    public function authorize(): bool
    {
        return true;
    }
}
