import 'zone.js';
import { Buffer } from 'buffer';
(window as any).global = window;
(window as any).Buffer = Buffer;

import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { Amplify } from 'aws-amplify';

// Same Cognito user pool as the IoT Energy Monitoring Dashboard (App 1) —
// IoT-MeterOps reuses one login/session, but only Admin-group users pass
// the app's own login checks (see core/services/auth.service.ts).
Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: 'ap-south-1_4VkTk63Sb',
      userPoolClientId: '4eq79hrecpnl7cqdh5efqdlqee',
    },
  },
});

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
