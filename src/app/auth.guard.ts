import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './core/services/auth.service';

// Protects dashboard/operations/history routes — only a signed-in Admin
// (Cognito "Admin" group) passes. Everyone else is sent to /login.
export const authGuard: CanActivateFn = async () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  const restored = await authService.restoreSession();
  if (restored) {
    return true;
  }
  return router.parseUrl('/login');
};

// Keeps an already-authenticated admin from seeing the login page again.
export const guestGuard: CanActivateFn = async () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  const authenticated = await authService.isAuthenticated();
  if (authenticated) {
    return router.parseUrl('/dashboard');
  }
  return true;
};
