import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './auth.guard';

export const routes: Routes = [
  { path: '', redirectTo: 'login', pathMatch: 'full' },
  {
    path: 'login',
    loadComponent: () =>
      import('./features/login/login.component').then((m) => m.LoginComponent),
    canActivate: [guestGuard],
  },
  {
    path: 'dashboard',
    loadComponent: () =>
      import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
    canActivate: [authGuard],
  },
  {
    // MAC ID selected -> operations dropdown lives on this page
    path: 'operations/:macId',
    loadComponent: () =>
      import('./features/operations/operations.component').then((m) => m.OperationsComponent),
    canActivate: [authGuard],
  },
  {
    // Operation clicked -> section detail page
    // :section is one of: receipt | booking-payment | installation |
    //                      monitoring-service | disconnection | current-status
    path: 'operations/:macId/:section',
    loadComponent: () =>
      import('./features/operations/section-detail.component').then(
        (m) => m.SectionDetailComponent,
      ),
    canActivate: [authGuard],
  },
  {
    // Browsable "all devices" list — used from two entry points:
    //   /devices                -> operations mode (default)
    //   /devices?for=history    -> history/audit-trail mode
    path: 'devices',
    loadComponent: () =>
      import('./features/device-list/device-list.component').then(
        (m) => m.DeviceListComponent,
      ),
    canActivate: [authGuard],
  },
  {
    // View-only, auto-updated complete audit trail — no edit/delete route exists.
    path: 'history/:macId',
    loadComponent: () =>
      import('./features/history/history.component').then((m) => m.HistoryComponent),
    canActivate: [authGuard],
  },
  { path: '**', redirectTo: 'login' },
];