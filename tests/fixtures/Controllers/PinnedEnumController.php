<?php

namespace App\Http\Controllers;

use Inertia\Inertia;

class PinnedEnumController extends Controller
{
    /**
     * @ferry kind OrderStatus
     * @ferry detail { value: OrderStatus; label: string }
     * @ferry explicit OrderStatusValue
     */
    public function show()
    {
        return Inertia::render('Pinned/Show', [
            'kind' => 'active',
            'detail' => 'x',
            'explicit' => 'y',
        ]);
    }
}
