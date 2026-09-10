<?php

namespace App\Http\Controllers;

use App\Enums\OrderStatus;
use Inertia\Inertia;

class ReportController extends Controller
{
    public function show()
    {
        return Inertia::render('Reports/Show', [
            'status' => $this->flagged ? OrderStatus::PENDING : null,
            'label' => $this->active ? 'open' : 'closed',
            'summary' => $this->cached ? $this->service->compute() : null,
        ]);
    }
}
