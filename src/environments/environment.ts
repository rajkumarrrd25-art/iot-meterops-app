// Fill these in with your EXISTING AWS backend values — this new app
// reuses the same Cognito user pool and API Gateway used by your
// IoT Energy Monitoring Dashboard project.

export const environment = {
  production: false,
  appTitle: 'IoT-MeterOps',

  // Cognito (same pool as your existing Angular dashboard)
  cognito: {
    region: 'ap-south-1',
    userPoolId: 'ap-south-1_4VkTk63Sb',
    userPoolWebClientId: '4eq79hrecpnl7cqdh5efqdlqee',
    identityPoolId: 'REPLACE_IDENTITY_POOL_ID', // not currently used
  },

  // API Gateway base URL that fronts the Device Lifecycle Lambda.
  // Deployed via CloudShell — see meterops-backend/DEPLOY.md for how
  // this was created (DynamoDB table: MeterOpsDeviceLifecycle,
  // Lambda: MeterOpsDeviceLifecycle, API: MeterOpsDeviceLifecycleApi).
  apiBaseUrl: 'https://8am3ovg6m1.execute-api.ap-south-1.amazonaws.com/prod',

  endpoints: {
    dashboardSummary: '/devices/summary',
    devicesList:    '/devices',
    device:         '/devices/{macId}',
    deviceOperations: '/devices/{macId}/operations',
    receipt:        '/devices/{macId}/receipt',
    bookingPayment: '/devices/{macId}/booking-payment',
    installation:   '/devices/{macId}/installation',
    monitoringService: '/devices/{macId}/monitoring-service',
    disconnection:  '/devices/{macId}/disconnection',
    currentStatus:  '/devices/{macId}/current-status',
    history:        '/devices/{macId}/history',
    customerFeedback: '/devices/{macId}/feedback',
  },
};