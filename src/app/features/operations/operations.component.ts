import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { ActivatedRoute, RouterModule, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';
import { jsPDF } from 'jspdf';
import { DeviceApiService } from '../../core/services/device-api.service';
import { LiveDeviceStatusService } from '../../core/services/live-device-status.service';
import { OperationSection, ReceiptRecord } from '../../core/models/device.model';
import { normalizeMacId, MAC_ID_FORMAT_ERROR } from '../../core/utils/mac-id.util';
import { isFutureDateOnly, compareLifecycleDates } from '../../core/utils/date-rules.util';
import { downloadPdf } from '../../core/utils/pdf-download.util';

interface OperationOption {
  key: OperationSection;
  label: string;
  sub: string;
  icon: string;
}

// This list is LOCKED per the discussion — do not add/remove without
// re-confirming, since every downstream page (routing, forms, DynamoDB
// item shape) is keyed off these six values. Receipt/stock moved OUT of
// this grid — it's captured once, at the "add device" step below, not as
// a separate operation card.
const ALL_OPERATIONS: OperationOption[] = [
  { key: 'booking-payment', label: 'Booking + payment', sub: 'Customer booking', icon: 'calendar' },
  { key: 'installation', label: 'Installation', sub: 'Field deployment', icon: 'pin' },
  { key: 'monitoring-service', label: 'Monitoring & service', sub: 'Complaints and repairs', icon: 'activity' },
  { key: 'disconnection', label: 'Disconnection', sub: 'Stop or terminate', icon: 'power' },
  { key: 'current-status', label: 'Current status', sub: 'Read only', icon: 'gauge' },
  { key: 'customer-feedback', label: 'Customer feedback', sub: 'From customer app', icon: 'feedback' },
];

type ReceiptDraft = Omit<ReceiptRecord, 'macId'>;

@Component({
  selector: 'app-operations',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './operations.component.html',
  styleUrl: './operations.component.css',
})
export class OperationsComponent implements OnInit, OnDestroy {
  macId = '';
  operations = signal<OperationOption[]>(ALL_OPERATIONS);
  available = signal<string[]>([]); // sections that already have data for this device

  hasData = computed(() => new Set(this.available()));

  // null = still checking, false = MAC ID not added yet, true = device exists.
  deviceExists = signal<boolean | null>(null);
  adding = signal(false);
  addError = signal<string | null>(null);

  // Device was just added but its intake device-status check came back
  // 'Not OK' — treated as returned to supplier / rejected. No operations
  // grid for it. ('Damaged' is not a condition value — every condition
  // goes through the same OK / Not OK check, see deviceStatus below.)
  rejected = signal(false);

  // Receipt/stock is now filled in right here, as part of adding the
  // device — condition, supplier, delivery mode, receipt no. all go in
  // together with the bare macId record.
  receiptDraft = signal<ReceiptDraft>(this.emptyReceiptDraft());

  // Shared default shape for the receipt form — used on first load and
  // whenever Clear is pressed.
  private emptyReceiptDraft(): ReceiptDraft {
    return {
      supplier: '',
      dateReceived: '',
      condition: 'New',
      deliveryMode: 'Courier',
      receiptNo: '',
      deviceStatus: 'OK',
      remarks: '',
      decision: undefined,
      checkingStatus: 'Pending',
      returned: { date: '', deliveryMode: '', receiptNo: '' },
    };
  }

  // Shared shape for loading a saved ReceiptRecord back into the draft
  // form — used by checkDevice() (first load) and startEditReceipt().
  private populateReceiptDraft(r: ReceiptRecord): ReceiptDraft {
    return {
      supplier: r.supplier ?? '',
      dateReceived: r.dateReceived ?? '',
      condition: r.condition ?? 'New',
      deliveryMode: r.deliveryMode ?? 'Courier',
      receiptNo: r.receiptNo ?? '',
      deviceStatus: r.deviceStatus ?? 'OK',
      remarks: r.remarks ?? '',
      decision: r.decision,
      checkingStatus: r.checkingStatus ?? 'Pending',
      returned: r.returned ?? { date: '', deliveryMode: '', receiptNo: '' },
    };
  }

  // A receipt reaches a TERMINAL "this device can't proceed" outcome in
  // two independent ways, and both are now handled identically:
  //   1. deviceStatus === 'Not OK'      — failed intake check, any condition.
  //   2. checkingStatus === 'Rejected'  — a Used/Refurbished unit (deviceStatus
  //      'OK') that failed its follow-up checking-status review.
  // Either one means remarks + a decision (Pending / Returned to supplier)
  // are required, and this is the single place that check lives — the
  // rest of the component (validation, the rejected screen, locking,
  // the PDF) calls this instead of re-deriving it. Previously a
  // Rejected checking status was a dead end with no way to record why
  // or what happens next; this brings it in line with Not OK.
  isRejectedOutcome(r: { deviceStatus: string; checkingStatus?: string }): boolean {
    return r.deviceStatus === 'Not OK' || r.checkingStatus === 'Rejected';
  }

  // True whenever Remarks becomes a required field. Three independent
  // reasons, any one of which is enough:
  //   1. isRejectedOutcome() — describe what's wrong (see above).
  //   2. condition !== 'New' — note on prior usage / what was refurbished.
  //   3. deliveryMode !== 'Courier' — note on why a Hand delivery / Self
  //      pickup was used instead of the standard courier route.
  // Single source of truth for both validateReceiptDraft() and the
  // template, so the "when is Remarks shown/required" logic can't drift
  // between the two.
  remarksRequired(r: ReceiptDraft): boolean {
    return this.isRejectedOutcome(r) || r.condition !== 'New' || r.deliveryMode !== 'Courier';
  }

  // Placeholder text reflects whichever reason(s) actually apply, so the
  // field doesn't just say "Describe the issue" when there's no issue —
  // it's a Hand-delivery note, or a used-condition note, or both.
  remarksPlaceholder(r: ReceiptDraft): string {
    if (this.isRejectedOutcome(r)) return 'Describe the issue';
    const reasons: string[] = [];
    if (r.condition !== 'New') reasons.push('prior usage / what was refurbished');
    if (r.deliveryMode !== 'Courier') reasons.push('why this delivery mode was used');
    return reasons.length ? `Note on ${reasons.join(' and ')}` : '';
  }

  // Shared validation for both addDevice() and saveReceiptEdit() — one
  // place to keep the "what's required, when" rules in sync.
  private validateReceiptDraft(draft: ReceiptDraft): string | null {
    if (!draft.supplier.trim() || !draft.dateReceived || !draft.receiptNo.trim()) {
      return 'Supplier, date received, and receipt no. are required.';
    }
    // A device is only added once it has actually been received — this is
    // a completed event, so a future date is never valid here (unlike, say,
    // a scheduled installation visit further down the lifecycle).
    if (isFutureDateOnly(draft.dateReceived)) {
      return 'Date received cannot be in the future.';
    }
    if (this.isRejectedOutcome(draft)) {
      if (!draft.remarks?.trim()) return 'Remarks describing the issue are required.';
      if (!draft.decision) return 'A decision (Pending / Returned to supplier) is required.';
      if (draft.decision === 'Returned to supplier') {
        const returnDate = draft.returned?.date;
        if (!returnDate) return 'Return date is required when the decision is Returned to supplier.';
        if (isFutureDateOnly(returnDate)) return 'Return date cannot be in the future.';
        if (compareLifecycleDates(returnDate, draft.dateReceived) < 0) {
          return 'Return date cannot be earlier than the date received.';
        }
      }
      return null;
    }
    if (this.remarksRequired(draft) && !draft.remarks?.trim()) {
      const usedOrRefurb = draft.condition !== 'New';
      const nonCourier = draft.deliveryMode !== 'Courier';
      if (usedOrRefurb && nonCourier) {
        return 'Remarks are required for a Used/Refurbished device received by a non-Courier delivery mode.';
      }
      if (usedOrRefurb) {
        return 'Remarks are required for Used/Refurbished devices.';
      }
      return 'Remarks are required when delivery mode is Hand delivery or Self pickup.';
    }
    return null;
  }

  // Turns a failed saveReceipt() call into the right on-screen message.
  // A duplicate receiptNo is a genuine, expected failure case — not a
  // connection problem — so it needs its own wording instead of the
  // generic "check your connection" fallback. Waiting on the backend to
  // actually enforce this (409 Conflict on a receiptNo already used by
  // a different MAC ID, e.g. via a GSI on receiptNo) — this is the
  // frontend half, ready for whenever that lands. Until then, any
  // error still falls through to the generic message unchanged.
  private receiptSaveErrorMessage(err: unknown, fallback: string): string {
    if (err instanceof HttpErrorResponse) {
      if (err.status === 409) {
        const backendMessage = (err.error && (err.error.message || err.error.error)) as string | undefined;
        return backendMessage || 'This receipt no. is already on file for another device. Use a different receipt no.';
      }
    }
    return fallback;
  }

  // Shared shape for the outgoing PUT body — the backend also strips
  // whichever of checkingStatus/decision/returned don't apply, but
  // sending a clean payload keeps the frontend's own state consistent.
  private buildReceiptPayload(draft: ReceiptDraft): ReceiptRecord {
    return {
      ...draft,
      macId: this.macId,
      checkingStatus:
        draft.deviceStatus === 'OK' && (draft.condition === 'Used' || draft.condition === 'Refurbished')
          ? (draft.checkingStatus ?? 'Pending')
          : undefined,
      decision: this.isRejectedOutcome(draft) ? draft.decision : undefined,
      returned: draft.decision === 'Returned to supplier' ? draft.returned : undefined,
    };
  }

  // Set when the macId in the URL itself isn't a valid MAC address —
  // blocks the whole add/operations flow instead of silently treating
  // a typo as a brand-new device.
  invalidMacId = signal(false);
  macIdFormatError = MAC_ID_FORMAT_ERROR;

  // Editing the receipt/stock record for an already-added device, from
  // the mac-header's Edit button (reuses the same receiptDraft form).
  editingReceipt = signal(false);
  savingReceipt = signal(false);
  receiptMessage = signal<string | null>(null);
  deleting = signal(false);
  deleteError = signal<string | null>(null);

  // True when this receipt panel was opened as a READ-ONLY view (deep
  // link from History, ?view=receipt) rather than via the mac-header's
  // Edit pencil. No Save/Cancel in this mode — just the details and a
  // Download button.
  receiptViewOnly = signal(false);

  constructor(
    private route: ActivatedRoute,
    private api: DeviceApiService,
    private router: Router,
    private liveStatus: LiveDeviceStatusService,
  ) {}

  ngOnInit(): void {
    this.macId = this.route.snapshot.paramMap.get('macId') ?? '';
    const normalized = normalizeMacId(this.macId);
    if (!normalized) {
      this.invalidMacId.set(true);
      this.deviceExists.set(false);
      return;
    }
    this.macId = normalized;
    // Deep-link support: History links here with ?view=receipt so a
    // RECEIPT timeline entry opens straight into the receipt details
    // instead of dropping the user on the plain operations grid.
    const openReceiptOnLoad = this.route.snapshot.queryParamMap.get('view') === 'receipt';
    this.checkDevice(openReceiptOnLoad);
  }

  private checkDevice(openReceiptOnLoad = false): void {
    this.deviceExists.set(null);
    this.api.checkDevice(this.macId).pipe(
      catchError(() => of(null)),
    ).subscribe((r) => {
      if (r) {
        this.deviceExists.set(true);
        // checkDevice() actually hits the receipt endpoint under the hood,
        // so this response already carries condition/deviceStatus/
        // checkingStatus — keep it in receiptDraft right away. Without
        // this, the operations grid would use the blank default ('New',
        // 'OK') until Edit was opened, so Used/Refurbished-pending-check
        // (or failed-check) devices would wrongly show as unlocked on
        // first load.
        const receipt = r as unknown as ReceiptRecord;
        this.receiptDraft.set(this.populateReceiptDraft(receipt));
        // A terminal receipt outcome — deviceStatus 'Not OK', OR a
        // Used/Refurbished unit whose checkingStatus is 'Rejected' — is
        // always routed to the "device rejected" screen, never the
        // locked operations grid, whichever field it came in on. This
        // was the actual bug under the old 'Damaged' condition: a
        // device edited to Damaged after being added kept showing the
        // normal grid with the generic "pending checking status" lock
        // message instead of the correct rejected/returned messaging —
        // and later, a Rejected checking status had the same problem:
        // a dead-end lock message with no decision to record.
        this.rejected.set(this.isRejectedOutcome(receipt));
        this.loadAvailable();
        if (openReceiptOnLoad) {
          this.receiptViewOnly.set(true);
          this.startEditReceipt();
        }
      } else {
        this.deviceExists.set(false);
      }
    });
  }

  // "Monitoring & service" is marked on file from THREE independent
  // sources, any one is enough — it no longer requires a customer
  // complaint specifically:
  //   1. a MONITORING or SERVICE# item already exists in DynamoDB
  //      (customer complaint/feedback, or a service entry logged here)
  //   2. the live status check has actually resolved for this device —
  //      "found", Off or On, as long as the API answered at all
  //      (status.resolved). A self-installed device has no technician
  //      to ever log a SERVICE# entry and no complaint either, so
  //      requiring a genuine non-null timestamp here was a dead end —
  //      Disconnection and Customer feedback stayed locked forever even
  //      for a device that's actually working fine, just currently
  //      reporting Off. Only an actual failed/timed-out check
  //      (status.resolved === false) should NOT count.
  private loadAvailable(): void {
    this.api.getAvailableOperations(this.macId).subscribe((avail) => {
      // avail is { sections, bookingStatus, installationStatus } — NOT a
      // bare string[] (see AvailableOperationsResponse / device-api.service.ts
      // for why). Unwrapping .sections here is what was missing: handing
      // the raw object to `this.available` meant hasData()'s `new Set(...)`
      // threw on every read, which is why Booking + payment (never
      // stage-gated — see isStageLocked()) looked fine while Installation
      // onward stayed locked no matter what was actually saved.
      this.available.set(avail.sections);
      this.liveStatus.getStatus(this.macId).subscribe((status) => {
        if (status.resolved && !this.available().includes('monitoring-service')) {
          this.available.set([...this.available(), 'monitoring-service']);
        }
      });
    });
  }

  // Step 1: add the MAC ID + its receipt/stock intake details together.
  // deviceStatus 'Not OK' on receipt -> rejected / returned to supplier
  // (or decision pending), stop here. Otherwise every other section
  // below is filled in independently, later, whenever that stage
  // actually happens. This device-status check applies uniformly to
  // every condition (New, Used, Refurbished) — there is no separate
  // 'Damaged' condition value anymore.
  addDevice(): void {
    const draft = this.receiptDraft();
    if (!this.macId || this.adding()) return;
    const error = this.validateReceiptDraft(draft);
    if (error) {
      this.addError.set(error);
      return;
    }
    this.adding.set(true);
    this.addError.set(null);

    this.api.saveReceipt(this.buildReceiptPayload(draft)).subscribe({
      next: () => {
        this.adding.set(false);
        if (this.isRejectedOutcome(draft)) {
          this.rejected.set(true);
        } else {
          this.deviceExists.set(true);
          this.loadAvailable();
        }
      },
      error: (err) => {
        this.adding.set(false);
        this.addError.set(this.receiptSaveErrorMessage(err, 'Could not add this device. Check your connection and try again.'));
      },
    });
  }

  // Pencil icon on the mac-header — always opens in full edit mode,
  // even if a previous view-only visit left receiptViewOnly set.
  openReceiptEdit(): void {
    this.receiptViewOnly.set(false);
    this.startEditReceipt();
  }

  // Edit button on the mac-header — loads the existing receipt/stock
  // record back into the same form so it can be corrected and re-saved.
  startEditReceipt(): void {
    this.editingReceipt.set(true);
    this.addError.set(null);
    this.api.getReceipt(this.macId).pipe(catchError(() => of(null))).subscribe((r) => {
      if (r) {
        this.receiptDraft.set(this.populateReceiptDraft(r));
      }
    });
  }

  cancelEditReceipt(): void {
    this.editingReceipt.set(false);
    this.receiptMessage.set(null);
    this.receiptViewOnly.set(false);
    this.addError.set(null);
  }

  // Close button shown in read-only mode (deep-linked from History) —
  // just dismisses the panel, no save happens either way.
  // Close on the read-only view — this page was only reached via a
  // History deep-link (?view=receipt), so Close returns there, same
  // as every other section's read-only Close button.
  closeReceiptView(): void {
    this.editingReceipt.set(false);
    this.receiptViewOnly.set(false);
    this.router.navigate(['/history', this.macId]);
  }

  // Download button in read-only mode — generates a real PDF of the
  // currently-loaded receipt details, laid out as label/value rows.
  downloadReceipt(): void {
    const d = this.receiptDraft();
    const doc = new jsPDF();

    const marginX = 20;
    let y = 22;

    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('Receipt / Stock Details', marginX, y);
    y += 10;

    doc.setDrawColor(200);
    doc.line(marginX, y, 190, y);
    y += 10;

    const row = (label: string, value: string) => {
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.text(label.toUpperCase(), marginX, y);
      doc.setFontSize(12);
      doc.setFont('helvetica', 'normal');
      doc.text(value || '-', marginX, y + 6);
      y += 16;
    };

    row('MAC ID', this.macId);
    row('Supplier', d.supplier);
    row('Date received', d.dateReceived);
    row('Delivery mode', d.deliveryMode);
    row('Receipt no.', d.receiptNo);
    row('Condition', d.condition);
    row('Device status', d.deviceStatus);
    if (d.deviceStatus === 'OK' && (d.condition === 'Used' || d.condition === 'Refurbished')) {
      row('Checking status', d.checkingStatus ?? 'Pending');
    }
    if (this.isRejectedOutcome(d)) {
      row('Decision', d.decision ?? '');
    }
    if (this.remarksRequired(d) || d.remarks) {
      row('Remarks', d.remarks ?? '');
    }

    if (this.isRejectedOutcome(d) && d.decision === 'Returned to supplier' && d.returned) {
      y += 4;
      doc.setDrawColor(230);
      doc.line(marginX, y, 190, y);
      y += 10;
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.text('Return Details', marginX, y);
      y += 10;

      row('Return date', d.returned.date);
      row('Return delivery mode', d.returned.deliveryMode);
      row('Return receipt no.', d.returned.receiptNo);
    }

    downloadPdf(doc, `receipt-${this.macId}.pdf`)
      .catch((err) => console.error('PDF download failed', err));
  }

  saveReceiptEdit(): void {
    const draft = this.receiptDraft();
    const error = this.validateReceiptDraft(draft);
    if (error) {
      this.addError.set(error);
      return;
    }
    if (this.savingReceipt()) return; // guard against double-submit
    this.savingReceipt.set(true);
    this.addError.set(null);
    this.receiptMessage.set(null);
    this.api.saveReceipt(this.buildReceiptPayload(draft)).subscribe({
      next: (res: any) => {
        this.savingReceipt.set(false);
        // Backend returns `changed: false` when nothing was actually
        // different from what's on file — surface that instead of
        // silently closing the form, so re-saving unedited details
        // doesn't read as a normal successful save.
        if (res && res.changed === false) {
          this.receiptMessage.set('No changes to save.');
          return;
        }
        this.editingReceipt.set(false);
        // Re-derive the rejected/returned state from whatever was just
        // saved — this is what routes a device edited TO 'Not OK', or
        // to a Rejected checking status, into the rejected screen
        // (instead of the operations grid), and routes one edited back
        // to OK/Accepted back into the normal grid.
        this.rejected.set(this.isRejectedOutcome(draft));
        this.loadAvailable();
      },
      error: (err) => {
        this.savingReceipt.set(false);
        this.addError.set(this.receiptSaveErrorMessage(err, 'Could not save changes. Check your connection and try again.'));
      },
    });
  }

  // Wrong details entered — reset the receipt form back to blank so it
  // can be filled in again, without leaving edit mode.
  clearReceiptDraft(): void {
    this.receiptDraft.set(this.emptyReceiptDraft());
    this.addError.set(null);
    this.receiptMessage.set(null);
  }

  // True once this device is allowed into Booking/Installation/etc:
  //  - isRejectedOutcome() (Not OK, or checkingStatus Rejected) -> never
  //    unlocked (rejected() short-circuits to its own screen first)
  //  - New, deviceStatus OK              -> always unlocked
  //  - Used/Refurbished, deviceStatus OK -> unlocked only once
  //    checkingStatus is 'Accepted'
  operationsUnlocked(): boolean {
    const r = this.receiptDraft();
    if (this.isRejectedOutcome(r)) return false;
    if (r.condition === 'New') return true;
    if (r.condition === 'Used' || r.condition === 'Refurbished') {
      return r.checkingStatus === 'Accepted';
    }
    return false;
  }

  // In practice a rejected outcome routes to its own screen (see
  // `rejected()` / the rejected-card) before this is ever shown, so this
  // only covers the still-pending-review case. Kept unified with
  // isRejectedOutcome() anyway, so a Rejected checking status never
  // falls back to reading as a dead end here either.
  lockedReason(): string {
    const r = this.receiptDraft();
    if (this.isRejectedOutcome(r)) {
      const cause =
        r.deviceStatus === 'Not OK'
          ? 'failed its intake check'
          : `failed the checking status for this ${r.condition.toLowerCase()} unit`;
      return r.decision === 'Returned to supplier'
        ? `This device ${cause} and was returned to supplier — no operations apply.`
        : `This device ${cause} — decision is still pending, no operations apply yet.`;
    }
    return `Locked — pending checking status for this ${r.condition.toLowerCase()} device.`;
  }

  // Sequential stage gate — ON TOP OF operationsUnlocked() above. Booking
  // must be done before Installation, Installation before Monitoring, and
  // Monitoring before Disconnection. "Done" = a record already exists for
  // that section (same hasData() the "On file" badge already uses).
  // Current status stays OUT of this — it's a read-only view, only gated
  // by the receipt-level lock above. Customer feedback is a special case,
  // not a link in this chain — it needs Monitoring & service on file (same
  // as Disconnection), but doesn't itself require Disconnection, since a
  // customer can leave feedback whether or not the device has since been
  // disconnected.
  //
  // "Monitoring & service on file" itself is broader than just a MONITORING
  // DynamoDB item now — see loadAvailable() below, which also marks it on
  // file once the live status check has resolved for the device (found,
  // Off or On — an actual failed/timed-out check doesn't count) or when a
  // SERVICE# history entry exists, not only when a customer complaint has
  // been raised.
  private readonly stageOrder: OperationSection[] = [
    'booking-payment',
    'installation',
    'monitoring-service',
    'disconnection',
  ];

  private isStageLocked(key: OperationSection): boolean {
    if (key === 'customer-feedback') {
      return !this.hasData().has('monitoring-service');
    }
    const idx = this.stageOrder.indexOf(key);
    if (idx <= 0) return false; // not a gated stage, or it's Booking (first — nothing to skip)
    // Check the WHOLE chain up to this stage, not just the immediate
    // predecessor. Immediate-only checking was exploitable: monitoring-service
    // can be marked "on file" purely from a live telemetry ping (see
    // loadAvailable() above), with no booking or installation record ever
    // having existed. That let Disconnection unlock on a telemetry blip
    // alone, skipping Booking + payment and Installation entirely.
    return this.stageOrder.slice(0, idx).some((prevKey) => !this.hasData().has(prevKey));
  }

  // Single check the template/click-handler use — locked if EITHER the
  // receipt-level lock hasn't cleared yet OR (once it has) this stage's
  // predecessor hasn't been completed yet.
  isCardLocked(key: OperationSection): boolean {
    return !this.operationsUnlocked() || this.isStageLocked(key);
  }

  // Reason shown in the title tooltip and, on a blocked click, the toast.
  cardLockedReason(key: OperationSection): string {
    if (!this.operationsUnlocked()) return this.lockedReason();
    if (key === 'customer-feedback') {
      const prevLabel = this.operations().find((o) => o.key === 'monitoring-service')?.label ?? 'monitoring-service';
      return `Previous step skipped — complete ${prevLabel} first`;
    }
    // Name the first missing stage in the chain (e.g. Booking + payment),
    // not just this card's immediate predecessor — otherwise Disconnection
    // would tell someone to "complete Monitoring & service" when Booking
    // and Installation are the ones actually missing.
    const idx = this.stageOrder.indexOf(key);
    const missingKey = this.stageOrder.slice(0, idx).find((k) => !this.hasData().has(k)) ?? this.stageOrder[idx - 1];
    const missingLabel = this.operations().find((o) => o.key === missingKey)?.label ?? missingKey;
    return `Previous step skipped — complete ${missingLabel} first`;
  }

  // Transient bottom toast for a blocked card click. Auto-dismisses on its
  // own so it doesn't linger like the permanent locked-banner above.
  skipToast = signal<string | null>(null);
  private skipToastTimer: ReturnType<typeof setTimeout> | null = null;

  onOpCardClick(op: OperationOption): void {
    if (this.isCardLocked(op.key)) {
      this.skipToast.set(this.cardLockedReason(op.key));
      if (this.skipToastTimer) clearTimeout(this.skipToastTimer);
      this.skipToastTimer = setTimeout(() => this.skipToast.set(null), 3200);
      return; // locked — do NOT navigate
    }
    this.router.navigate(['/operations', this.macId, op.key]);
  }

  ngOnDestroy(): void {
    if (this.skipToastTimer) clearTimeout(this.skipToastTimer);
  }

  // Delete button on the mac-header — removes this device entirely.
  // Opens a custom themed confirm modal (instead of the plain browser
  // confirm()) since this deletes every record (receipt, booking,
  // installation, service history, etc.) for the MAC ID.
  showDeleteConfirm = signal(false);

  confirmDeleteDevice(): void {
    this.showDeleteConfirm.set(true);
  }

  cancelDeleteDevice(): void {
    this.showDeleteConfirm.set(false);
  }

  proceedDeleteDevice(): void {
    this.showDeleteConfirm.set(false);
    this.deleting.set(true);
    this.deleteError.set(null);
    this.api.deleteDevice(this.macId).subscribe({
      next: () => this.router.navigate(['/dashboard']),
      error: () => {
        this.deleting.set(false);
        this.deleteError.set('Could not delete this device. Check your connection and try again.');
      },
    });
  }
}