import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of, forkJoin } from 'rxjs';
import { jsPDF } from 'jspdf';
import { DeviceApiService } from '../../core/services/device-api.service';
import {
  LiveDeviceStatusService,
  LIVE_STATUS_POLL_INTERVAL_MS,
} from '../../core/services/live-device-status.service';
import {
  BookingPaymentRecord,
  InstallationRecord,
  MonitoringServiceRecord,
  ServiceRecord,
  ServiceResolutionType,
  DisconnectionRecord,
  CurrentStatusRecord,
  CustomerFeedback,
  OperationSection,
  ReceiptRecord,
  ComplaintRecord,
} from '../../core/models/device.model';
import { isFutureDateOnly, isFutureDateTime, compareLifecycleDates } from '../../core/utils/date-rules.util';
import { downloadPdf } from '../../core/utils/pdf-download.util';

@Component({
  selector: 'app-section-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './section-detail.component.html',
  styleUrls: ['./section-detail.component.css'],
})
export class SectionDetailComponent implements OnInit, OnDestroy {
  macId = '';
  section = signal<OperationSection>('booking-payment');

  // True when this page was deep-linked from History (?view=readonly) —
  // read-only mode: no Save/Clear/edit anywhere, only a Download PDF +
  // Close. Same idea as the Receipt read-only view on the Operations
  // page, just applied to every section instead of receipt only.
  viewOnly = signal(false);

  bookingPayment = signal<BookingPaymentRecord | null>(null);
  installation = signal<InstallationRecord | null>(null);
  monitoringService = signal<MonitoringServiceRecord | null>(null);
  // Receipt's dateReceived is the earliest possible date in this device's
  // lifecycle — fetched unconditionally (like bookingPayment above) purely
  // so date validation below can enforce "not earlier than date received"
  // regardless of which section page happens to be open.
  receipt = signal<ReceiptRecord | null>(null);

  // Live ON/OFF for the Monitoring & Service page — sourced from the SAME
  // live device-monitoring API/logic App 1 already uses (see
  // LiveDeviceStatusService). This intentionally does NOT read
  // ms.currentSystemStatus / ms.lastReportedAt, which are historical
  // fields written from service entries, not real-time device state.
  liveOnline = signal<boolean | null>(null);
  liveTimestamp = signal<number | null>(null);
  private liveStatusIntervalId?: ReturnType<typeof setInterval>;

  liveStatusText = computed(() => {
    const online = this.liveOnline();
    if (online === null) return 'Checking…';
    return online ? 'On' : 'Off';
  });

  liveLastUpdatedText = computed(() => {
    const ts = this.liveTimestamp();
    if (!ts) return '--';
    return new Date(ts).toLocaleString('en-IN');
  });
  disconnection = signal<DisconnectionRecord | null>(null);
  currentStatus = signal<CurrentStatusRecord | null>(null);
  customerFeedback = signal<CustomerFeedback[]>([]);

  // Per-section save state. `savingX` disables the Save button the
  // moment it's clicked — this is what actually stops a tech from
  // firing the same save 4-5 times while waiting for a slow/absent
  // response, which was the real source of the duplicate HISTORY
  // entries (the backend's no-op guard is the second line of defence).
  // `xMessage` shows "Saved" / "No changes to save" using the backend's
  // `changed` flag; `xError` shows on failure.
  savingBooking = signal(false);
  bookingMessage = signal<string | null>(null);
  bookingError = signal<string | null>(null);

  savingInstallation = signal(false);
  installationMessage = signal<string | null>(null);
  installationError = signal<string | null>(null);

  savingService = signal(false);
  serviceMessage = signal<string | null>(null);
  serviceError = signal<string | null>(null);

  savingDisconnection = signal(false);
  disconnectionMessage = signal<string | null>(null);
  disconnectionError = signal<string | null>(null);

  // New service entry being drafted, if the tech opens "add service".
  newService = signal<Partial<ServiceRecord>>(this.emptyServiceDraft());

  private emptyServiceDraft(): Partial<ServiceRecord> {
    return {
      technicianName: '',
      technicianPhone: '',
      date: '',
      resolutionType: 'Repair' as ServiceResolutionType,
      amount: { value: 0, status: 'Paid' },
      repair: { description: '', remarks: '' },
      replacementSpare: { partName: '', cost: 0, remarks: '' },
      replacementDevice: { oldMacId: '', newMacId: '', date: '', byWhom: '', remarks: '', receipt: '' },
    };
  }

  constructor(
    private route: ActivatedRoute,
    private api: DeviceApiService,
    private router: Router,
    private liveStatus: LiveDeviceStatusService,
  ) {}

  ngOnInit(): void {
    this.macId = this.route.snapshot.paramMap.get('macId') ?? '';
    this.section.set((this.route.snapshot.paramMap.get('section') as OperationSection) ?? 'booking-payment');
    this.viewOnly.set(this.route.snapshot.queryParamMap.get('view') === 'readonly');
    this.load();
  }

  private load(): void {
    // Booking + payment data drives cross-section logic — the
    // installation lock (installationLocked()) and the self-install
    // default below — so it's fetched unconditionally, not only when
    // its own tab happens to be open. Previously this only worked if
    // the tech had visited Booking + Payment earlier in the same
    // session; landing on Installation directly (bookmark, deep link,
    // or Operations menu) left bookingPayment() empty and silently
    // broke both the lock and the self-install default.
    this.api.getBookingPayment(this.macId).pipe(
      catchError(() => of(this.emptyBookingPayment())),
    ).subscribe((bp) => this.bookingPayment.set(bp));

    this.api.getReceipt(this.macId).pipe(
      catchError(() => of(null)),
    ).subscribe((r) => this.receipt.set(r));

    switch (this.section()) {
      case 'booking-payment':
        // Already loaded above — nothing further to do.
        break;
      case 'installation':
        // Fetched together with booking-payment (forkJoin, not two
        // independent subscribes) so the self-install default below is
        // never computed against a stale/empty bookingPayment() value.
        forkJoin({
          bp: this.api.getBookingPayment(this.macId).pipe(
            catchError(() => of(this.emptyBookingPayment())),
          ),
          inst: this.api.getInstallation(this.macId).pipe(
            catchError(() => of(null)),
          ),
        }).subscribe(({ bp, inst }) => {
          if (inst) {
            // Record already exists — respect whatever was actually
            // saved, even if it now disagrees with Booking (e.g. the
            // booking was changed after installation was logged).
            this.installation.set(inst);
          } else {
            // First time opening this section for this device — default
            // "installed by customer" from the Booking + Payment
            // installation mode instead of asking the tech to re-decide
            // Self vs By technician a second time.
            const draft = this.emptyInstallation();
            draft.installedByCustomer = bp.installationMode === 'Self';
            this.installation.set(draft);
          }
        });
        break;
      case 'monitoring-service':
        this.api.getMonitoringService(this.macId).subscribe((r) => {
          this.monitoringService.set(r);
          // Bug fix: the service form never linked back to the open
          // complaint it was addressing, so submitService() sent no
          // complaintId and the backend's "resolve on service" logic
          // (POST monitoring-service/service, body.complaintId branch)
          // never fired — complaint stayed OPEN and the device stage
          // stayed stuck on "Complaint" forever, no matter how many
          // service entries got logged against it.
          // When there's exactly one open complaint, default the draft
          // to resolve it — tech can still change/clear it via the
          // "Resolves complaint" dropdown before saving.
          const open = (r.complaints || []).filter((c) => c.status === 'Open');
          if (open.length === 1 && !this.newService().complaintId) {
            this.newService.update((d) => ({ ...d, complaintId: open[0].complaintId }));
          }
        });
        // Needed for service-date lower-bound validation below — a
        // service entry can't predate the installation it's servicing.
        this.api.getInstallation(this.macId).pipe(
          catchError(() => of(null)),
        ).subscribe((inst) => this.installation.set(inst));
        this.startLiveStatusPolling();
        break;
      case 'disconnection':
        this.api.getDisconnection(this.macId).pipe(
          catchError(() => of(this.emptyDisconnection())),
        ).subscribe((r) => this.disconnection.set(r));
        // Needed for disconnection-date lower-bound validation below.
        this.api.getInstallation(this.macId).pipe(
          catchError(() => of(null)),
        ).subscribe((inst) => this.installation.set(inst));
        break;
      case 'current-status':
        // Read-only, derived server-side — no save button on this section at all.
        this.api.getCurrentStatus(this.macId).subscribe((r) => this.currentStatus.set(r));
        break;
      case 'customer-feedback':
        // Read-only — written by the customer app, never from here.
        this.api.getCustomerFeedback(this.macId).pipe(
          catchError(() => of([] as CustomerFeedback[])),
        ).subscribe((r) => this.customerFeedback.set(r));
        break;
    }
  }

  // =====================================================
  // LIVE DEVICE STATUS POLLING (Monitoring & Service page)
  // Mirrors App 1's startLiveVoltagePolling(): fetch immediately, then
  // refresh every LIVE_STATUS_POLL_INTERVAL_MS (60s) while this page is
  // open, so the tech never has to manually refresh the browser to see
  // the current device state.
  // =====================================================

  private startLiveStatusPolling(): void {
    this.stopLiveStatusPolling();

    this.fetchLiveStatus();

    this.liveStatusIntervalId = setInterval(() => {
      // Don't poll a hidden/background tab — same guard App 1 uses.
      if (document.hidden) return;
      this.fetchLiveStatus();
    }, LIVE_STATUS_POLL_INTERVAL_MS);
  }

  private stopLiveStatusPolling(): void {
    if (this.liveStatusIntervalId !== undefined) {
      clearInterval(this.liveStatusIntervalId);
      this.liveStatusIntervalId = undefined;
    }
  }

  private fetchLiveStatus(): void {
    this.liveStatus.getStatus(this.macId).subscribe((status) => {
      this.liveOnline.set(status.online);
      this.liveTimestamp.set(status.timestamp);
    });
  }

  // Sensible blank starting points for first-time entry — used only when
  // the GET 404s because this section has no record yet for this MAC ID.
  private emptyBookingPayment(): BookingPaymentRecord {
    return {
      macId: this.macId,
      customer: { name: '', address: '', email: '', phone: '' },
      bookingDate: '',
      bookingStatus: 'Pending',
      installationMode: 'Self',
      paymentMode: 'Offline',
      quotedPrice: 0,
      amountPaid: 0,
      amountPending: 0,
    };
  }

  // Amount pending is derived, not typed in directly — this is the single
  // place that keeps it in sync with quotedPrice and amountPaid so the
  // three numbers can never quietly disagree with each other.
  recalcAmountPending(bp: BookingPaymentRecord): void {
    const quoted = Number(bp.quotedPrice) || 0;
    const paid = Number(bp.amountPaid) || 0;
    bp.amountPending = Math.max(quoted - paid, 0);
  }

  private emptyInstallation(): InstallationRecord {
    return {
      macId: this.macId,
      installedByCustomer: false,
      technicianName: '',
      installationDateTime: '',
      chargeType: 'Free',
      quotedAmount: 0,
      paymentStatus: 'Pending',
      paymentMode: 'Offline',
      paymentDate: '',
      completedDateTime: '',
      installationStatus: 'Pending',
      remarks: '',
    };
  }

  // Charge type drives quoted amount / payment mode visibility, same
  // pattern as Booking + Payment's paid/free logic — Free installs
  // never need an amount or a payment mode on file.
  showInstallationPaidFields(inst: InstallationRecord): boolean {
    return inst.chargeType === 'Paid';
  }

  // Payment Mode and Payment Date & Time are only meaningful once the
  // payment has actually gone through — a Pending payment status has
  // neither yet, so those two fields stay hidden and unrequired until
  // Payment Status flips to Paid.
  showInstallationPaymentPaidFields(inst: InstallationRecord): boolean {
    return inst.chargeType === 'Paid' && inst.paymentStatus === 'Paid';
  }

  // Remarks are mandatory once Work Completion status is anything other
  // than a clean Completed — this is what actually explains a Pending
  // hold-up or a Failed visit instead of leaving a bare status label.
  installationRemarksRequired(inst: InstallationRecord): boolean {
    return inst.installationStatus === 'Pending' || inst.installationStatus === 'Failed';
  }

  // Required-field guard for Installation. Two paths:
  //   - self-install: a lightweight "confirm" tab — the customer's own
  //     confirmation date/time is the one required field. This is what
  //     actually flips installationStatus to Completed (see
  //     confirmSelfInstall() below) — filling this in and saving IS the
  //     confirmation, not a silent side-effect of the checkbox alone.
  //   - technician path: unchanged, full completion form below.
  private validateInstallationDraft(inst: InstallationRecord): string | null {
    if (inst.installedByCustomer) {
      if (!inst.installationDateTime) {
        return 'Enter the date & time the customer installed this device to confirm it.';
      }
      if (isFutureDateTime(inst.installationDateTime)) {
        return 'Installation date & time cannot be in the future.';
      }
      const bp = this.bookingPayment();
      if (bp?.bookingDate && compareLifecycleDates(inst.installationDateTime, bp.bookingDate) < 0) {
        return 'Installation date & time cannot be earlier than the booking date.';
      }
      return null;
    }

    if (!inst.technicianName) return 'Technician name is required.';
    if (!inst.installationDateTime) return 'Installation date & time is required.';
    // installationDateTime is a SCHEDULE (the technician visit being
    // booked), not a claim that it already happened — a future date here
    // is legitimate and must NOT be rejected. It still can't predate the
    // booking it belongs to.
    const bp = this.bookingPayment();
    if (bp?.bookingDate && compareLifecycleDates(inst.installationDateTime, bp.bookingDate) < 0) {
      return 'Installation date & time cannot be earlier than the booking date.';
    }
    if (!inst.chargeType) return 'Pick a charge type.';
    if (inst.chargeType === 'Paid') {
      if (!(Number(inst.quotedAmount) > 0)) {
        return 'Quoted amount is required and must be greater than 0 for a paid installation.';
      }
      if (!inst.paymentStatus) return 'Pick a payment status for a paid installation.';
      if (inst.paymentStatus === 'Paid') {
        if (!inst.paymentMode) return 'Pick a payment mode for a paid installation.';
        if (!inst.paymentDate) return 'Payment date & time is required when payment status is Paid.';
        // Payment status 'Paid' means the payment has already happened.
        if (inst.paymentDate && isFutureDateTime(inst.paymentDate)) {
          return 'Payment date & time cannot be in the future for a completed payment.';
        }
      }
    }
    // Work completion: a status of 'Completed' is a claim that the visit
    // already happened, so it needs an actual (non-future) completion
    // date that isn't earlier than the scheduled visit itself.
    if (inst.installationStatus === 'Completed' && !inst.completedDateTime) {
      return 'Completed date & time is required when work completion status is Completed.';
    }
    if (inst.completedDateTime) {
      if (isFutureDateTime(inst.completedDateTime)) {
        return 'Completed date & time cannot be in the future.';
      }
      if (compareLifecycleDates(inst.completedDateTime, inst.installationDateTime) < 0) {
        return 'Completed date & time cannot be earlier than the installation date & time.';
      }
    }
    if (this.installationRemarksRequired(inst) && !inst.remarks) {
      return `Remarks are required when work completion status is ${inst.installationStatus}.`;
    }
    return null;
  }

  private emptyDisconnection(): DisconnectionRecord {
    return {
      macId: this.macId,
      byWhom: 'Customer',
      name: '',
      date: '',
      type: 'Temporary stop',
      reason: 'Payment issue',
    };
  }

  // Human-readable explanation for each derived status — so "Pending"
  // etc. doesn't read as a mystery value with no context.
  statusDescription(status: string): string {
    switch (status) {
      case 'Pending':
        return 'In inventory / receipt on file — not booked or installed yet.';
      case 'Booked':
        return 'Booking confirmed — waiting for installation.';
      case 'Active':
        return 'Installed and running at the customer site.';
      case 'Disconnected':
        return 'Service stopped — a disconnection was recorded for this device.';
      case 'Replaced':
        return 'This physical device was swapped out during a service visit.';
      case 'Returned':
        return 'Intake device-status check came back Not OK — no further lifecycle applies.';
      default:
        return '';
    }
  }

  // Required-field guard for Booking + Payment — mirrors
  // validateServiceDraft() for Monitoring. Without this, Save
  // silently accepted a completely empty form (no customer name, no
  // phone, no booking date) and wrote it straight to the device's
  // permanent record.
  //
  // quotedPrice is mandatory (and must be > 0) for any non-cancelled
  // booking. Without this, blanking/zeroing the quote made
  // recalcAmountPending() compute amountPending as 0 - 0 = 0, which
  // read as "fully paid" even though nothing was ever quoted or paid —
  // Save let that straight through with no warning.
  private validateBookingDraft(bp: BookingPaymentRecord): string | null {
    if (!bp.customer.name) return 'Customer name is required.';
    if (!bp.customer.phone) return 'Customer phone is required.';
    if (!bp.bookingDate) return 'Booking date is required.';
    // A booking is recorded once it actually happens (Pending/Confirmed/
    // Cancelled are all outcomes of a booking that already took place) —
    // so a future booking date is never valid, unlike a scheduled
    // installation visit further down the lifecycle.
    if (isFutureDateOnly(bp.bookingDate)) {
      return 'Booking date cannot be in the future.';
    }
    const receipt = this.receipt();
    if (receipt?.dateReceived && compareLifecycleDates(bp.bookingDate, receipt.dateReceived) < 0) {
      return 'Booking date cannot be earlier than the date the device was received.';
    }
    if (bp.bookingStatus === 'Cancelled' && !bp.cancellationReason) {
      return 'Pick a cancellation reason.';
    }
    if (bp.bookingStatus === 'Cancelled' && bp.cancellationReason === 'Other' && !bp.cancellationNote) {
      return 'Add a note for the cancellation reason.';
    }
    if (bp.bookingStatus === 'Confirmed' && !(Number(bp.quotedPrice) > 0)) {
      return 'Quoted price is required and must be greater than 0.';
    }
    if (Number(bp.amountPaid) > Number(bp.quotedPrice)) {
      return 'Amount paid cannot be greater than the quoted price.';
    }
    if (bp.paymentDate) {
      // Payment date on file means the payment already happened.
      if (isFutureDateOnly(bp.paymentDate)) return 'Payment date cannot be in the future.';
      if (compareLifecycleDates(bp.paymentDate, bp.bookingDate) < 0) {
        return 'Payment date cannot be earlier than the booking date.';
      }
    }
    return null;
  }

  // One-line "where does payment stand" readout — shown next to the
  // form and on the read-only view, so it's never ambiguous whether a
  // booking is fully paid or still owed something, instead of the tech
  // having to do the Quoted − Paid subtraction themselves.
  paymentStatusLabel(bp: BookingPaymentRecord): string {
    if (!(Number(bp.quotedPrice) > 0)) return 'No quote entered yet';
    if (bp.amountPending > 0) return `Pending — ₹${bp.amountPending} still owed`;
    return 'Paid in full';
  }

  saveBookingPayment(): void {
    const r = this.bookingPayment();
    // Guard against double-submit: while a save is already in flight,
    // a second click (or the form re-firing ngSubmit) is ignored.
    if (!r || this.savingBooking()) return;

    const validationMessage = this.validateBookingDraft(r);
    if (validationMessage) {
      this.bookingError.set(validationMessage);
      return;
    }

    this.savingBooking.set(true);
    this.bookingMessage.set(null);
    this.bookingError.set(null);
    this.api.saveBookingPayment(r).subscribe({
      next: (res: any) => {
        this.savingBooking.set(false);
        const changed = !(res && res.changed === false);
        this.bookingMessage.set(changed ? 'Saved.' : 'No changes to save.');
        // Only leave the page on an actual save — "no changes" (or a
        // validation error, which already returns above before this
        // ever runs) should keep the tech right here with the reason
        // visible, not silently bounce them back to the grid.
        if (changed) {
          this.router.navigate(['/operations', this.macId]);
        }
      },
      error: (err) => {
        this.savingBooking.set(false);
        this.bookingError.set(err?.error?.error ?? 'Could not save changes. Check your connection and try again.');
      },
    });
  }

  // "Clear" — wrong details were entered and not yet saved (or saved
  // wrong and about to be redone): reset this card's form back to a
  // blank draft so it can be filled in again from scratch, without
  // touching whatever is already on the backend until Save is pressed.
  clearBookingPayment(): void {
    this.bookingPayment.set(this.emptyBookingPayment());
    this.bookingMessage.set(null);
    this.bookingError.set(null);
  }

  // Single source of truth: Booking status gates every downstream section
  // (Installation, Monitoring, Disconnection). Only 'Confirmed' opens the
  // gate — 'Pending' isn't a decision yet, and 'Cancelled' is permanent.
  // Returns null when the gate is open, or the reason to show when closed.
  bookingGateReason(): string | null {
    const bp = this.bookingPayment();
    if (!bp) return null;
    if (bp.bookingStatus === 'Cancelled') {
      const reason = bp.cancellationReason ? ` (${bp.cancellationReason})` : '';
      return `Booking was cancelled${reason} — this device's cycle stops here.`;
    }
    if (bp.bookingStatus === 'Pending') {
      return 'Booking is not confirmed yet — confirm the booking before proceeding.';
    }
    return null;
  }

  // Installation adds one more gate on top of the shared booking gate:
  // Self-install always skips it, and Online payment with a pending
  // balance blocks until fully paid.
  installationLockReason(): string | null {
    const inst = this.installation();
    if (inst?.installedByCustomer) return null;

    const bookingReason = this.bookingGateReason();
    if (bookingReason) return bookingReason;

    const bp = this.bookingPayment();
    if (bp && bp.paymentMode === 'Online' && bp.amountPending > 0) {
      return 'Locked — online payment must be confirmed before installation can proceed.';
    }
    return null;
  }

  installationLocked(): boolean {
    return this.installationLockReason() !== null;
  }

  saveInstallation(): void {
    if (this.installationLocked()) return; // extra safety — backend must also enforce this
    const r = this.installation();
    if (!r || this.savingInstallation()) return;

    const validationMessage = this.validateInstallationDraft(r);
    if (validationMessage) {
      this.installationError.set(validationMessage);
      return;
    }

    // Self-install has its own short "confirm" form now (see
    // validateInstallationDraft above and the template's separate
    // installedByCustomer branch) — the customer's install date/time is
    // a required field there, so reaching this point means it was
    // actually filled in and validated, not silently defaulted. That
    // filled-in date IS the completion event for a self-install, so it
    // doubles as completedDateTime and installationStatus flips to
    // Completed right here. Without this, installationStatus stayed at
    // emptyInstallation()'s 'Pending' default forever for a
    // self-installed device — it never counted as Installed on the
    // Dashboard, never flipped to 'Active' in Current status, and never
    // unlocked the rest of the lifecycle chain gated on Installation
    // being done, even though the device genuinely IS installed.
    const payload: InstallationRecord = r.installedByCustomer
      ? { ...r, installationStatus: 'Completed', completedDateTime: r.installationDateTime }
      : r;

    this.savingInstallation.set(true);
    this.installationMessage.set(null);
    this.installationError.set(null);
    this.api.saveInstallation(payload).subscribe({
      next: (res: any) => {
        this.savingInstallation.set(false);
        const changed = !(res && res.changed === false);
        this.installationMessage.set(changed ? 'Saved.' : 'No changes to save.');
        this.installation.set(payload);
        if (changed) {
          this.router.navigate(['/operations', this.macId]);
        }
      },
      error: () => {
        this.savingInstallation.set(false);
        this.installationError.set('Could not save changes. Check your connection and try again.');
      },
    });
  }

  clearInstallation(): void {
    this.installation.set(this.emptyInstallation());
    this.installationMessage.set(null);
    this.installationError.set(null);
  }

  // Complaints this service entry can resolve — only 'Open' ones (an
  // 'In-progress' or already-'Resolved' complaint isn't offered here).
  openComplaints(): ComplaintRecord[] {
    return (this.monitoringService()?.complaints || []).filter((c) => c.status === 'Open');
  }

  // Resolution-type-driven field visibility inside Service.
  showRepairFields(): boolean {
    return this.newService().resolutionType === 'Repair';
  }
  showSpareFields(): boolean {
    return this.newService().resolutionType === 'Replacement-Spare';
  }
  showDeviceReplacementFields(): boolean {
    return this.newService().resolutionType === 'Replacement-Device';
  }

  // Required-field guard — runs before the API call, so an empty or
  // half-filled form can never reach the backend (this is what was
  // producing blank rows in Service history). Backend re-validates the
  // same fields independently; this is just the fast, friendly copy of
  // that check for the UI.
  private validateServiceDraft(draft: Partial<ServiceRecord>): string | null {
    if (!draft.resolutionType) return 'Pick a resolution type.';
    if (!draft.date) return 'Date is required.';
    // A service visit is logged after it happens — a future date is
    // never valid here.
    if (isFutureDateOnly(draft.date)) return 'Service date cannot be in the future.';
    const inst = this.installation();
    const installLowerBound = inst?.completedDateTime || inst?.installationDateTime;
    if (installLowerBound && compareLifecycleDates(draft.date, installLowerBound) < 0) {
      return 'Service date cannot be earlier than the installation date.';
    }
    if (!draft.technicianName) return 'Technician name is required.';
    if (!draft.technicianPhone) return 'Technician phone number is required.';
    if (draft.resolutionType === 'Repair' && !draft.repair?.description) {
      return 'Add a repair description.';
    }
    if (draft.resolutionType === 'Replacement-Spare' && !draft.replacementSpare?.partName) {
      return 'Add the spare part name.';
    }
    if (draft.resolutionType === 'Replacement-Device') {
      if (!draft.replacementDevice?.newMacId) return 'Add the new MAC ID.';
      const replaceDate = draft.replacementDevice?.date;
      if (replaceDate) {
        if (isFutureDateOnly(replaceDate)) return 'Replacement date cannot be in the future.';
        if (compareLifecycleDates(replaceDate, draft.date) < 0) {
          return 'Replacement date cannot be earlier than the service date.';
        }
      }
    }
    return null;
  }

  submitService(): void {
    const draft = this.newService();
    if (this.savingService()) return;

    const gateReason = this.bookingGateReason();
    if (gateReason) {
      this.serviceError.set(gateReason);
      return;
    }

    const validationMessage = this.validateServiceDraft(draft);
    if (validationMessage) {
      this.serviceError.set(validationMessage);
      return;
    }

    const payload: Partial<ServiceRecord> = {
      technicianName: draft.technicianName,
      technicianPhone: draft.technicianPhone,
      date: draft.date,
      complaintId: draft.complaintId || undefined,
      amount: draft.amount,
      resolutionType: draft.resolutionType,
      repair: draft.resolutionType === 'Repair' ? draft.repair : undefined,
      replacementSpare: draft.resolutionType === 'Replacement-Spare' ? draft.replacementSpare : undefined,
      replacementDevice: draft.resolutionType === 'Replacement-Device' ? draft.replacementDevice : undefined,
    };
    this.savingService.set(true);
    this.serviceMessage.set(null);
    this.serviceError.set(null);
    this.api
      .saveService(this.macId, payload as ServiceRecord)
      .subscribe({
        next: (res: any) => {
          this.savingService.set(false);
          // draft.complaintId was sent — but the backend only resolves
          // it if a complaint with that exact ID was actually found on
          // file (see resolvedComplaintId in the response). Selecting a
          // complaint in the dropdown and having it silently NOT
          // resolve (stale page, complaint already closed elsewhere,
          // id mismatch) was invisible before — this surfaces it
          // instead of letting the tech assume it worked and navigate
          // away.
          if (draft.complaintId && !res?.resolvedComplaintId) {
            this.serviceError.set(
              `Service entry saved, but complaint ${draft.complaintId} could not be found to mark Resolved. Refresh this page and check its status before assuming it's closed.`,
            );
            this.newService.set(this.emptyServiceDraft());
            this.load();
            return;
          }
          this.serviceMessage.set(
            res?.resolvedComplaintId
              ? `Service entry saved. Complaint ${res.resolvedComplaintId} marked Resolved.`
              : 'Service entry saved.',
          );
          this.newService.set(this.emptyServiceDraft());
          this.load();
          // Unlike the other sections' PUTs, this endpoint always
          // creates a new entry on success (duplicates are rejected
          // with a 409 into the error branch below, never a
          // changed:false here) — so reaching this callback always
          // means a real save happened.
          this.router.navigate(['/operations', this.macId]);
        },
        error: (err) => {
          this.savingService.set(false);
          if (err.status === 409) {
            this.serviceError.set(err.error?.reason ?? 'This service entry looks like a duplicate.');
          } else {
            this.serviceError.set('Could not save this service entry. Check your connection and try again.');
          }
        },
      });
  }

  // Clear only the "log new service" draft — doesn't touch the
  // complaints/service history already on file.
  clearServiceDraft(): void {
    this.newService.set(this.emptyServiceDraft());
    this.serviceMessage.set(null);
    this.serviceError.set(null);
  }

  // Disconnection had NO field validation at all before this — Save went
  // straight to the API once the booking gate was clear, so even a blank
  // date could be submitted. A disconnection is logged after it happens,
  // so (like Service/Receipt) a future date is never valid; it also can't
  // predate the installation being disconnected.
  private validateDisconnectionDraft(d: DisconnectionRecord): string | null {
    if (!d.date) return 'Disconnection date is required.';
    if (isFutureDateOnly(d.date)) return 'Disconnection date cannot be in the future.';
    const inst = this.installation();
    const installLowerBound = inst?.completedDateTime || inst?.installationDateTime;
    if (installLowerBound && compareLifecycleDates(d.date, installLowerBound) < 0) {
      return 'Disconnection date cannot be earlier than the installation date.';
    }
    return null;
  }

  saveDisconnection(): void {
    const r = this.disconnection();
    if (!r || this.savingDisconnection()) return;

    const gateReason = this.bookingGateReason();
    if (gateReason) {
      this.disconnectionError.set(gateReason);
      return;
    }

    const validationMessage = this.validateDisconnectionDraft(r);
    if (validationMessage) {
      this.disconnectionError.set(validationMessage);
      return;
    }

    this.savingDisconnection.set(true);
    this.disconnectionMessage.set(null);
    this.disconnectionError.set(null);
    this.api.saveDisconnection(r).subscribe({
      next: (res: any) => {
        this.savingDisconnection.set(false);
        const changed = !(res && res.changed === false);
        this.disconnectionMessage.set(changed ? 'Saved.' : 'No changes to save.');
        if (changed) {
          this.router.navigate(['/operations', this.macId]);
        }
      },
      error: () => {
        this.savingDisconnection.set(false);
        this.disconnectionError.set('Could not save changes. Check your connection and try again.');
      },
    });
  }

  clearDisconnection(): void {
    this.disconnection.set(this.emptyDisconnection());
    this.disconnectionMessage.set(null);
    this.disconnectionError.set(null);
  }

  // "Temporary stop" disconnections shouldn't be stuck as Disconnected
  // forever once the underlying issue (payment received, etc.) is
  // sorted out. This reuses the same PUT /disconnection endpoint the
  // form above already calls — it just re-sends the existing record
  // with status: 'Reconnected' + a timestamp, which the backend treats
  // as "no longer a live disconnection" for stage/status purposes
  // while keeping the record on file for history.
  reconnecting = signal(false);

  canReconnect(): boolean {
    const d = this.disconnection();
    // d.date is required on every real saved disconnection (see
    // validateDisconnectionDraft) — an empty date means this is just
    // the blank emptyDisconnection() draft (no disconnection has
    // actually been logged for this device yet), not a real record to
    // reconnect from.
    return !!d && !!d.date && d.type === 'Temporary stop' && d.status !== 'Reconnected';
  }

  reconnectDevice(): void {
    const r = this.disconnection();
    if (!r || !this.canReconnect() || this.reconnecting()) return;

    this.reconnecting.set(true);
    this.disconnectionMessage.set(null);
    this.disconnectionError.set(null);

    const payload: DisconnectionRecord = {
      ...r,
      status: 'Reconnected',
      reconnectedAt: new Date().toISOString(),
    };

    this.api.saveDisconnection(payload).subscribe({
      next: () => {
        this.reconnecting.set(false);
        this.disconnectionMessage.set('Device reconnected — no longer counted as Disconnected.');
        this.disconnection.set(payload);
        this.load();
      },
      error: () => {
        this.reconnecting.set(false);
        this.disconnectionError.set('Could not reconnect. Check your connection and try again.');
      },
    });
  }

  // Download button in read-only (History deep-link) mode — one PDF
  // generator that lays out whichever section is currently open as
  // label/value rows, same visual style as the existing Receipt PDF.
  downloadSectionPdf(): void {
    const doc = new jsPDF();
    const marginX = 20;
    let y = 22;

    const title = (text: string) => {
      doc.setFontSize(16);
      doc.setFont('helvetica', 'bold');
      doc.text(text, marginX, y);
      y += 10;
      doc.setDrawColor(200);
      doc.line(marginX, y, 190, y);
      y += 10;
    };

    const row = (label: string, value: string) => {
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.text(label.toUpperCase(), marginX, y);
      doc.setFontSize(12);
      doc.setFont('helvetica', 'normal');
      doc.text(value || '-', marginX, y + 6);
      y += 16;
    };

    const sub = (text: string) => {
      y += 4;
      doc.setDrawColor(230);
      doc.line(marginX, y, 190, y);
      y += 10;
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.text(text, marginX, y);
      y += 10;
    };

    const section = this.section();

    if (section === 'booking-payment') {
      const bp = this.bookingPayment();
      title('Booking + Payment Details');
      row('MAC ID', this.macId);
      if (bp) {
        row('Customer name', bp.customer.name);
        row('Address', bp.customer.address);
        row('Email', bp.customer.email);
        row('Phone', bp.customer.phone);
        row('Booking date', bp.bookingDate);
        row('Booking status', bp.bookingStatus);
        if (bp.bookingStatus === 'Confirmed') {
          row('Installation mode', bp.installationMode);
          row('Payment mode', bp.paymentMode);
          row('Amount paid', String(bp.amountPaid));
          row('Amount pending', String(bp.amountPending));
          if (bp.paymentDate) row('Payment date', bp.paymentDate);
        }
      }
    } else if (section === 'installation') {
      const inst = this.installation();
      title('Installation Details');
      row('MAC ID', this.macId);
      if (inst) {
        row('Installed by customer (self)', inst.installedByCustomer ? 'Yes' : 'No');
        if (!inst.installedByCustomer) {
          sub('Booking');
          row('Technician name', inst.technicianName ?? '');
          row('Installation date & time', inst.installationDateTime ?? '');
          row('Charge type', inst.chargeType ?? '');
          if (inst.chargeType === 'Paid') {
            row('Quoted amount', String(inst.quotedAmount ?? ''));
          }
          sub('Work Completion');
          row('Completed date & time', inst.completedDateTime ?? '');
          row('Status', inst.installationStatus ?? '');
          if (inst.chargeType === 'Paid') {
            row('Payment status', inst.paymentStatus ?? '');
            if (inst.paymentStatus === 'Paid') {
              row('Payment mode', inst.paymentMode ?? '');
              row('Payment date & time', inst.paymentDate ?? '');
            }
          }
          if (this.installationRemarksRequired(inst)) {
            row('Remarks', inst.remarks ?? '');
          }
        }
      }
    } else if (section === 'monitoring-service') {
      const ms = this.monitoringService();
      title('Monitoring & Service Details');
      row('MAC ID', this.macId);
      if (ms) {
        row('Current system status', ms.currentSystemStatus);
        row('Last reported at', ms.lastReportedAt);

        if (ms.complaints.length > 0) {
          sub('Complaints');
          ms.complaints.forEach((c) => row(c.raisedAt, `[${c.category}] ${c.description} (${c.status})`));
        }
        if (ms.services.length > 0) {
          sub('Service history');
          ms.services.forEach((s) => row(s.date, `${s.resolutionType} — by ${s.technicianName} (${s.technicianPhone})`));
        }
      }
    } else if (section === 'disconnection') {
      const d = this.disconnection();
      title('Disconnection Details');
      row('MAC ID', this.macId);
      if (d) {
        row('By whom', d.byWhom);
        row('Name', d.name);
        row('Date', d.date);
        row('Type', d.type);
        row('Reason', d.reason === 'Other' ? (d.otherReasonText || 'Other') : d.reason);
      }
    } else {
      title('Device Section Details');
      row('MAC ID', this.macId);
    }

    downloadPdf(doc, `${section}-${this.macId}.pdf`)
      .catch((err) => console.error('PDF download failed', err));
  }

  // Close button in read-only mode — this page was only reached via a
  // History deep-link, so "Close" returns there rather than to the
  // (editable) Operations grid.
  closeView(): void {
    this.router.navigate(['/history', this.macId]);
  }

  ngOnDestroy(): void {
    this.stopLiveStatusPolling();
  }
}