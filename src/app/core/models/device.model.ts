// One interface per locked-down section. Kept flat and simple so they
// map 1:1 onto DynamoDB items and Angular reactive forms.

export type OperationSection =
  | 'booking-payment'
  | 'installation'
  | 'monitoring-service'
  | 'disconnection'
  | 'current-status'
  | 'customer-feedback';

// Response shape of GET /devices/{macId}/available-operations. `sections`
// is what drives the "on file" / stage-lock checks (see
// operations.component.ts hasData()/isStageLocked()); bookingStatus and
// installationStatus ride along so a card can eventually show the real
// record state (e.g. "Confirmed" vs "Pending") instead of a flat "on
// file" badge — not wired into the UI yet, but the backend already
// returns them, so the type here matches the actual response.
export interface AvailableOperationsResponse {
  sections: OperationSection[];
  bookingStatus?: BookingPaymentRecord['bookingStatus'];
  installationStatus?: InstallationRecord['installationStatus'];
}

// Backend (Lambda) formula — locked, do not change without re-confirming:
//   totalDevices = count of DeviceRecord items in DynamoDB (every macId ever added)
//   installed    = count of devices with InstallationRecord.installationStatus === 'Completed'
//   currentStock = totalDevices - installed   (never fetched separately)
//   booked       = count of devices with BookingPaymentRecord.bookingStatus === 'Confirmed'
//                  (i.e. customer-side confirmation done, regardless of install status)
//   runningCount = count of devices whose latest hourly telemetry write (energy DB / App 1's
//                  consumption table) is within the last reporting window — NOT derived from
//                  this table, driven by the AWS IoT hourly-consumption updates
//   missingCount = installed devices with no telemetry in the expected window (offline)
export interface DashboardSummary {
  totalDevices: number;
  installed: number;
  currentStock: number;
  booked: number;
  runningCount: number;
  missingCount: number;
  customerComplaintsCount: number;
  customerFeedbackCount: number;
  // Classified off each device's LATEST feedback rating only (not every
  // rating it's ever received) — an old bad review doesn't keep a
  // device flagged once it's since rated well, and vice versa.
  badFeedbackCount: number;   // latest rating below 3★
  goodFeedbackCount: number;  // latest rating exactly 5★
}

// One row per device for the "all devices" list page — used by both the
// Operations flow (pick an existing MAC ID, or add a brand-new one) and
// the History flow (pick a MAC ID to view its audit trail). Kept light —
// this is a list-summary shape, not the full DeviceRecord.
//
// Receipt/stock is now captured at the moment a device is ADDED (see
// DeviceRecord below) — there is no more "added but no receipt" state.
// 'Damaged' is not a condition value — every condition goes through the
// same intake check (see ReceiptRecord.deviceStatus below). If that
// check comes back 'Not OK', the device is marked 'Rejected' and no
// further lifecycle stages apply to it.
export interface DeviceListItem {
  macId: string;
  createdAt: string;
  // Fleet-analysis bucket for the "All devices" list/filter — one bucket
  // per device, priority order: Instock < Booked < Active < Disconnected
  // < Complaint (Complaint wins over everything, incl. Disconnected, since
  // it's the most actionable state for support). 'Rejected' is terminal
  // (intake check failed) and only applies when nothing else progressed.
  // 'Active' reflects installation being Completed — it does NOT depend
  // on live telemetry; that's a separate concern (Dashboard's Running/
  // Missing-Offline tiles).
  stage: 'Instock' | 'Booked' | 'Active' | 'Disconnected' | 'Complaint' | 'Rejected';
  condition?: 'New' | 'Used' | 'Refurbished';
  bookingStatus?: 'Pending' | 'Confirmed' | 'Cancelled';
  installationStatus?: 'Pending' | 'Completed' | 'Failed';
  // Present only once a booking exists for this device — undefined for a
  // device still sitting at Received/Rejected with no customer attached yet.
  customerName?: string;
  customerPhone?: string;
  customerAddress?: string;
}

// The bare record that exists the moment a MAC ID is added — before any
// receipt, booking, or other section has been filled in.
export interface DeviceRecord {
  macId: string;
  createdAt: string;
}

// Response for GET /devices/{macId}/operations — which section records
// exist for this device, PLUS the actual status of Booking/Installation
// (when on file) so the Operations grid can show real state instead of
// a flat "On file" badge that reads the same whether Installation is
// Completed or still Pending.
export interface AvailableOperations {
  sections: OperationSection[];
  bookingStatus?: 'Pending' | 'Confirmed' | 'Cancelled';
  installationStatus?: 'Pending' | 'Completed' | 'Failed';
}

export interface ReceiptRecord {
  macId: string;
  supplier: string;
  dateReceived: string;
  condition: 'New' | 'Used' | 'Refurbished';
  deliveryMode: 'Courier' | 'Hand delivery' | 'Self pickup';
  receiptNo: string;
  // Physical/functional check run at intake for EVERY condition (New,
  // Used, Refurbished alike) — this replaces the old separate 'Damaged'
  // condition value. 'OK' devices proceed as normal (see checkingStatus
  // gating below); 'Not OK' devices require remarks + a decision and
  // are excluded from the rest of the lifecycle.
  deviceStatus: 'OK' | 'Not OK';
  // Required whenever this receipt reaches a TERMINAL outcome — either
  // deviceStatus 'Not OK', or (for a Used/Refurbished unit) checkingStatus
  // 'Rejected' — describing what's wrong. Also required, independently
  // of any terminal outcome, whenever condition is Used/Refurbished
  // (note on prior usage) and/or deliveryMode isn't 'Courier' (note on
  // why Hand delivery / Self pickup was used) — either reason alone
  // makes it mandatory.
  remarks?: string;
  // Only present for a terminal outcome — deviceStatus 'Not OK', or
  // checkingStatus 'Rejected' — what happens to a device that can't
  // proceed. A Rejected checking status used to be a dead end with no
  // way to record this; it now goes through the same decision flow as
  // a failed intake check.
  decision?: 'Pending' | 'Returned to supplier';
  // Only meaningful when condition is 'Used' or 'Refurbished' AND
  // deviceStatus is 'OK' — a further review before the device is
  // allowed to proceed to Booking/Installation. 'New' devices skip this
  // entirely (never gated), and a 'Not OK' device never gets this field.
  // 'Rejected' here is itself a terminal outcome (see decision above),
  // not a dead end.
  checkingStatus?: 'Pending' | 'Accepted' | 'Rejected';
  returned?: {
    date: string;
    deliveryMode: string;
    receiptNo: string;
  };
}

export interface BookingPaymentRecord {
  macId: string;
  customer: {
    name: string;
    address: string;
    email: string;
    phone: string;
  };
  bookingDate: string;
  bookingStatus: 'Pending' | 'Confirmed' | 'Cancelled';
  cancellationReason?: 'Customer request' | 'Duplicate entry' | 'Payment issue' | 'Device unavailable' | 'Other';
  cancellationNote?: string;
  installationMode: 'Self' | 'By technician';
  paymentMode: 'Online' | 'Offline';
  quotedPrice: number; // total quoted to the customer
  amountPaid: number;
  amountPending: number; // derived: quotedPrice - amountPaid (kept as a stored field so old records without quotedPrice still read correctly)
  paymentDate?: string;
}

export interface InstallationRecord {
  macId: string;
  installedByCustomer: boolean; // true => "Self" — no further fields needed
  // Gate logic (enforced in component, not just UI):
  // paymentMode === 'Online'  -> locked until BookingPaymentRecord.amountPending === 0
  // paymentMode === 'Offline' -> never gated by payment

  // ---- Part 1: Booking (scheduling the technician) — only when
  // installedByCustomer is false. Charge here is for the installation
  // visit itself, separate from the device's Booking + Payment quote.
  technicianName?: string;
  installationDateTime?: string; // date & time, datetime-local
  chargeType?: 'Free' | 'Paid';
  quotedAmount?: number;      // required when chargeType === 'Paid'
  paymentStatus?: 'Paid' | 'Pending'; // required when chargeType === 'Paid'
  paymentMode?: 'Online' | 'Offline'; // required when chargeType === 'Paid' AND paymentStatus === 'Paid'
  paymentDate?: string;        // date & time, datetime-local; required when chargeType === 'Paid' AND paymentStatus === 'Paid'

  // ---- Part 2: Work completion
  completedDateTime?: string; // date & time, datetime-local
  // Kept as `installationStatus` (not renamed) so the dashboard's
  // "installed" count and CURRENT_STATUS derivation, which key off this
  // exact field name, keep working unchanged.
  installationStatus?: 'Pending' | 'Completed' | 'Failed';
  remarks?: string; // required when installationStatus is 'Pending' or 'Failed'
}

export interface ComplaintRecord {
  complaintId: string;
  category: string;
  description: string;
  status: 'Open' | 'In-progress' | 'Resolved';
  raisedAt: string;
  // Written by the CUSTOMER APP, never from this app — read-only here.
  // Field names here must match the backend's complaint object exactly
  // (complaintId, category, description, status, raisedAt) — there is
  // no macId or dateTime on this object; macId lives on the parent
  // MONITORING item, and the timestamp field is raisedAt, not dateTime.
}

export type ServiceResolutionType = 'Repair' | 'Replacement-Spare' | 'Replacement-Device';

export interface ServiceRecord {
  macId: string;
  complaintId?: string; // link back to the complaint, if any
  technicianName: string;
  technicianPhone: string;
  date: string;
  amount: { value: number; status: 'Paid' | 'Free' };
  resolutionType: ServiceResolutionType;
  repair?: { description: string; remarks?: string };
  replacementSpare?: { partName: string; cost: number; remarks?: string };
  replacementDevice?: {
    oldMacId: string;
    newMacId: string;
    date: string;
    byWhom: string;
    remarks?: string;
    receipt: string;
  };
}

export interface MonitoringServiceRecord {
  macId: string;
  currentSystemStatus: 'On' | 'Off';
  lastReportedAt: string;
  complaints: ComplaintRecord[];
  services: ServiceRecord[];
}

export interface DisconnectionRecord {
  macId: string;
  byWhom: 'Customer' | 'Provider';
  name: string;
  date: string;
  type: 'Temporary stop' | 'Permanent';
  reason: 'Payment issue' | 'Other';
  otherReasonText?: string;
  // A 'Temporary stop' disconnection isn't necessarily permanent — once
  // the issue is resolved (payment received, etc.) it can be cleared via
  // the "Reconnect" action instead of staying stuck as Disconnected
  // forever. Undefined/omitted means still disconnected (the original
  // behavior); 'Reconnected' means the backend no longer counts this
  // record toward the device's live status or stage.
  status?: 'Reconnected';
  reconnectedAt?: string;
}

export interface CurrentStatusRecord {
  macId: string;
  status: 'Pending' | 'Active' | 'Disconnected' | 'Replaced' | 'Returned';
  location: string;
  // Always derived server-side from the latest event — never edited directly.
  // Pending    = receipt/stock exists, not installed yet
  // Active     = installation completed, running
  // Disconnected = a disconnection record exists
  // Replaced   = latest service was a device replacement
  // Returned   = terminal receipt outcome: intake device-status check came
  //              back Not OK, OR a Used/Refurbished unit's checking status
  //              came back Rejected
}

export interface HistoryEvent {
  macId: string;
  timestamp: string;
  stage: 'RECEIPT' | 'BOOKING' | 'INSTALLATION' | 'SERVICE' | 'DISCONNECTION' | 'REPLACEMENT' | 'COMPLAINT' | 'FEEDBACK';
  summary: string;   // one-line human readable summary for the timeline
  payload: unknown;  // the full record for that event (one of the types above)
}

export interface CustomerFeedback {
  rating: number; // 1-5
  comments: string;
  loggedAt: string;
  macId?: string;
  // Written by the CUSTOMER APP — standalone page here, read-only.
  // Field names here must match the backend's feedback object exactly
  // (rating, comments, loggedAt) — there is no customerName, feedbackText
  // or date on this object.
}