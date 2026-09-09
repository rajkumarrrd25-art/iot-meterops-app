import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import {
  signIn,
  signOut,
  fetchAuthSession,
  resetPassword,
  confirmResetPassword,
  confirmSignIn,
} from 'aws-amplify/auth';

// Reuses the SAME Cognito user pool as the IoT Energy Monitoring Dashboard
// (App 1) — configured once in main.ts via Amplify.configure().
//
// ADMIN-ONLY ACCESS: IoT-MeterOps is an internal ops tool. Only users in
// the Cognito "Admin" group are allowed to sign in. Any user who
// authenticates successfully but is NOT in the Admin group is immediately
// signed out and rejected with an error — regular/customer accounts must
// never reach the dashboard.

@Injectable({ providedIn: 'root' })
export class AuthService {
  constructor(private router: Router) {}

  async login(email: string, password: string): Promise<'SUCCESS' | 'NEW_PASSWORD_REQUIRED'> {
    // Clear any stale Cognito session first.
    try {
      const existing = await fetchAuthSession();
      if (existing.tokens) {
        await signOut();
      }
    } catch {
      // no existing session — fine
    }
    sessionStorage.clear();

    const result = await signIn({ username: email, password });

    if (result.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
      return 'NEW_PASSWORD_REQUIRED';
    }

    if (result.isSignedIn) {
      await this.saveAdminSessionOrReject();
      return 'SUCCESS';
    }

    throw new Error(`Unsupported sign-in step: ${result.nextStep.signInStep}`);
  }

  async setNewPassword(newPassword: string): Promise<void> {
    const result = await confirmSignIn({ challengeResponse: newPassword });
    if (!result.isSignedIn) {
      throw new Error(`Sign-in not completed: ${result.nextStep.signInStep}`);
    }
    await this.saveAdminSessionOrReject();
  }

  // Validates the signed-in user is in the Admin group. Non-admins are
  // signed out immediately and rejected — they never get a session here.
  private async saveAdminSessionOrReject(): Promise<void> {
    const session = await fetchAuthSession();
    const groups = (session.tokens?.idToken?.payload['cognito:groups'] as string[]) || [];
    const isAdmin = groups.includes('Admin');

    if (!isAdmin) {
      await signOut();
      sessionStorage.clear();
      throw new Error('Access restricted to admin users only. Please contact your administrator.');
    }

    const userEmail = session.tokens?.idToken?.payload['email'] as string | undefined;
    sessionStorage.setItem('role', 'Admin');
    if (userEmail) {
      sessionStorage.setItem('email', userEmail);
    }
    const idTokenString = session.tokens?.idToken?.toString();
    if (idTokenString) {
      sessionStorage.setItem('idToken', idTokenString);
    }
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      const session = await fetchAuthSession();
      return !!session.tokens?.idToken && sessionStorage.getItem('role') === 'Admin';
    } catch {
      return false;
    }
  }

  // Re-validates admin membership on every restore — not just presence of a token —
  // so a user demoted out of the Admin group loses access on next guard check.
  async restoreSession(): Promise<boolean> {
    try {
      const session = await fetchAuthSession();
      if (!session.tokens?.idToken) {
        return false;
      }
      const groups = (session.tokens.idToken.payload['cognito:groups'] as string[]) || [];
      if (!groups.includes('Admin')) {
        await signOut();
        sessionStorage.clear();
        return false;
      }
      const userEmail = session.tokens.idToken.payload['email'] as string | undefined;
      sessionStorage.setItem('role', 'Admin');
      if (userEmail) sessionStorage.setItem('email', userEmail);
      const idTokenString = session.tokens.idToken.toString();
      if (idTokenString) sessionStorage.setItem('idToken', idTokenString);
      return true;
    } catch {
      return false;
    }
  }

  async logout(): Promise<void> {
    try {
      await signOut();
    } finally {
      sessionStorage.clear();
      this.router.navigate(['/login']);
    }
  }

  async forgotPassword(email: string): Promise<void> {
    await resetPassword({ username: email });
  }

  async confirmForgotPassword(email: string, confirmationCode: string, newPassword: string): Promise<void> {
    await confirmResetPassword({ username: email, confirmationCode, newPassword });
  }

  getIdToken(): string | null {
    return sessionStorage.getItem('idToken');
  }

  getUserEmail(): string | null {
    return sessionStorage.getItem('email');
  }

  getRole(): string | null {
    return sessionStorage.getItem('role');
  }
}