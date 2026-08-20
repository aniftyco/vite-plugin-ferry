<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Resources\UserResource;
use Inertia\Inertia;

class DashboardController extends Controller
{
    public function index()
    {
        $user = auth()->user();

        return Inertia::render('Dashboard', [
            'user' => new UserResource($user),
            'total' => $this->repo->total(),
        ]);
    }

    /**
     * @ferry total number
     */
    public function stats()
    {
        $user = auth()->user();

        return Inertia::render('Dashboard', [
            'user' => new UserResource($user),
            'total' => $this->repo->total(),
        ]);
    }
}
