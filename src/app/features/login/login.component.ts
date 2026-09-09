import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, NgForm } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css',
})
export class LoginComponent {
  email = '';
  password = '';

  showPassword = signal<boolean>(false);
  loading = signal<boolean>(false);

  // First login / temporary password
  newPasswordRequired = signal<boolean>(false);
  firstLoginNewPassword = '';
  firstLoginConfirmPassword = '';

  // Forgot password
  isForgotModalOpen = signal<boolean>(false);
  forgotStep = signal<number>(1);
  resetEmail = '';
  otpCode = '';
  newPassword = '';
  confirmPassword = '';

  constructor(private router: Router, private authService: AuthService) {}

  togglePasswordVisibility(): void {
    this.showPassword.update((v) => !v);
  }

  onSubmit(form: NgForm): void {
    if (form.invalid) {
      form.control.markAllAsTouched();
      return;
    }
    this.login();
  }

  private login(): void {
    this.loading.set(true);

    this.authService
      .login(this.email, this.password)
      .then((result) => {
        this.loading.set(false);

        if (result === 'NEW_PASSWORD_REQUIRED') {
          this.newPasswordRequired.set(true);
          return;
        }

        this.router.navigate(['/dashboard'], { replaceUrl: true });
      })
      .catch((error) => {
        this.loading.set(false);
        alert(error?.message || 'Invalid email or password');
      });
  }

  setPermanentPassword(): void {
    if (!this.firstLoginNewPassword || !this.firstLoginConfirmPassword) {
      alert('Please enter and confirm your new password.');
      return;
    }
    if (this.firstLoginNewPassword !== this.firstLoginConfirmPassword) {
      alert('Passwords do not match!');
      return;
    }

    this.loading.set(true);

    this.authService
      .setNewPassword(this.firstLoginNewPassword)
      .then(() => {
        this.loading.set(false);
        this.newPasswordRequired.set(false);
        this.password = '';
        this.firstLoginNewPassword = '';
        this.firstLoginConfirmPassword = '';
        this.router.navigate(['/dashboard'], { replaceUrl: true });
      })
      .catch((error) => {
        this.loading.set(false);
        alert(error?.message || 'Unable to set new password.');
      });
  }

  openForgotModal(): void {
    this.resetEmail = this.email;
    this.forgotStep.set(1);
    this.isForgotModalOpen.set(true);
  }

  closeForgotModal(): void {
    this.isForgotModalOpen.set(false);
  }

  sendOtp(): void {
    if (!this.resetEmail) {
      alert('Please enter your email address.');
      return;
    }

    this.loading.set(true);

    this.authService
      .forgotPassword(this.resetEmail)
      .then(() => {
        this.loading.set(false);
        alert('OTP code has been sent to your email!');
        this.forgotStep.set(2);
      })
      .catch((error) => {
        this.loading.set(false);
        alert(error?.message || 'Failed to send OTP. Please check your email address.');
      });
  }

  confirmResetPassword(): void {
    if (!this.otpCode || !this.newPassword || !this.confirmPassword) {
      alert('Please fill in all fields.');
      return;
    }
    if (this.newPassword !== this.confirmPassword) {
      alert('Passwords do not match!');
      return;
    }

    this.loading.set(true);

    this.authService
      .confirmForgotPassword(this.resetEmail, this.otpCode, this.newPassword)
      .then(() => {
        this.loading.set(false);
        alert('Password updated successfully! Please login with your new password.');
        this.closeForgotModal();
        this.password = '';
      })
      .catch((error) => {
        this.loading.set(false);
        alert(error?.message || 'Invalid OTP or password update failed.');
      });
  }
}
