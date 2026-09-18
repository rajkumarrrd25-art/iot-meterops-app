import { Component, OnInit, computed, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';
import { jsPDF } from 'jspdf';
import { downloadPdf } from '../../core/utils/pdf-download.util';
import { DeviceApiService } from '../../core/services/device-api.service';
import { CurrentStatusRecord, HistoryEvent } from '../../core/models/device.model';

// IMPORTANT: this component must never call save/update/delete endpoints.
// getHistory() is a GET-only call — enforce the same read-only rule on
// the API Gateway route itself (no PUT/POST/DELETE method wired to it),
// not just here in the UI.

@Component({
  selector: 'app-history',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './history.component.html',
  styleUrl: './history.component.css',
})
export class HistoryComponent implements OnInit {
  macId = '';
  events = signal<HistoryEvent[]>([]);
  // Device profile (current status) shown above the timeline. Fetched
  // separately from history so one endpoint failing doesn't block the
  // other — a device can have history but a stale/missing CURRENT_STATUS
  // item (or vice versa) and the page should still render what it has.
  profile = signal<CurrentStatusRecord | null>(null);
  profileLoading = signal(true);
  // These MUST be signals, not plain fields — `computed()` only
  // re-runs when a signal it read changes. Plain fields mutated by
  // ngModel were silently invisible to filteredEvents(), which is why
  // the Stage/From/To filters looked like they did nothing.
  stageFilter = signal('');
  fromDate = signal('');
  toDate = signal('');
  loading = signal(true);
  // false once the device is confirmed to exist (even with zero events);
  // true if the MAC ID has never been added, so the lookup itself failed.
  notFound = signal(false);

  // Which history entry is currently open in the read-only detail
  // panel below the timeline (SERVICE / COMPLAINT / FEEDBACK /
  // REPLACEMENT only — see openEvent() for why).
  selectedEvent = signal<HistoryEvent | null>(null);

  filteredEvents = computed(() =>
    this.events().filter((ev) => {
      const stage = this.stageFilter();
      const from = this.fromDate();
      const to = this.toDate();
      if (stage && ev.stage !== stage) return false;
      // Compare by date only (first 10 chars of the ISO timestamp) —
      // comparing the full "...T16:50:25.413Z" timestamp against a
      // plain "YYYY-MM-DD" from the date input always sorts the
      // timestamp as "later", which silently excluded every event on
      // the selected "To" date.
      const evDate = ev.timestamp.slice(0, 10);
      if (from && evDate < from) return false;
      if (to && evDate > to) return false;
      return true;
    }),
  );

  constructor(private route: ActivatedRoute, private api: DeviceApiService, private router: Router) {}

  ngOnInit(): void {
    this.macId = this.route.snapshot.paramMap.get('macId') ?? '';

    this.loading.set(true);
    this.api.getHistory(this.macId).pipe(
      catchError(() => { this.notFound.set(true); return of([] as HistoryEvent[]); }),
    ).subscribe((events) => {
      this.events.set(events);
      this.loading.set(false);
    });

    this.profileLoading.set(true);
    this.api.getCurrentStatus(this.macId).pipe(
      // No CURRENT_STATUS item yet (e.g. device just added, nothing
      // saved) shouldn't block the timeline from rendering — just show
      // no profile card instead of erroring the whole page.
      catchError(() => of(null)),
    ).subscribe((profile) => {
      this.profile.set(profile);
      this.profileLoading.set(false);
    });
  }

  statusColor(status: CurrentStatusRecord['status'] | undefined): string {
    switch (status) {
      case 'Active': return 'green';
      case 'Pending': return 'amber';
      case 'Disconnected': return 'gray';
      case 'Replaced': return 'blue';
      case 'Returned': return 'red';
      default: return 'gray';
    }
  }

  stageColor(stage: HistoryEvent['stage']): string {
    switch (stage) {
      case 'RECEIPT': return 'gray';
      case 'BOOKING': return 'purple';
      case 'INSTALLATION': return 'green';
      case 'SERVICE': return 'amber';
      case 'DISCONNECTION': return 'red';
      case 'REPLACEMENT': return 'blue';
      case 'COMPLAINT': return 'pink';
      case 'FEEDBACK': return 'teal';
      default: return 'gray';
    }
  }

  // Where a timeline entry should take you when clicked, in Operations.
  // RECEIPT has no dedicated /:section route (it lives on the Operations
  // page itself, behind the mac-header Edit button) so it deep-links
  // there with ?view=receipt instead of a section segment.
  //
  // Only used for the SINGLETON record types (RECEIPT/BOOKING/
  // INSTALLATION/DISCONNECTION) — there's exactly one such record per
  // device, so "the current record" and "the historical record this
  // timeline entry refers to" are the same thing, and navigating to the
  // live Operations page for it is correct.
  sectionLink(stage: HistoryEvent['stage']): { path: any[]; queryParams?: Record<string, string> } {
    const base = ['/operations', this.macId];
    const readonly = { view: 'readonly' };
    switch (stage) {
      case 'RECEIPT': return { path: base, queryParams: { view: 'receipt' } };
      case 'BOOKING': return { path: [...base, 'booking-payment'], queryParams: readonly };
      case 'INSTALLATION': return { path: [...base, 'installation'], queryParams: readonly };
      case 'DISCONNECTION': return { path: [...base, 'disconnection'], queryParams: readonly };
      default: return { path: base };
    }
  }

  // SERVICE, REPLACEMENT, COMPLAINT and FEEDBACK are all MULTI-entry
  // types — a device can rack up many of each over its lifetime. For
  // these, "the live Monitoring & Service page" is NOT the same thing
  // as "this specific timeline entry": the live page always shows every
  // current complaint/service, so every one of these entries used to
  // open (or, for COMPLAINT/FEEDBACK, silently fail to open at all —
  // sectionLink() had no case for them and fell through to the plain
  // Operations grid) the same live view regardless of which entry was
  // clicked. Instead of navigating away and re-fetching live data, we
  // show the exact snapshot already sitting in ev.payload (that's the
  // whole point of storing it) in a read-only panel right here.
  isMultiEntryStage(stage: HistoryEvent['stage']): boolean {
    return stage === 'SERVICE' || stage === 'REPLACEMENT' || stage === 'COMPLAINT' || stage === 'FEEDBACK';
  }

  openEvent(ev: HistoryEvent): void {
    if (this.isMultiEntryStage(ev.stage)) {
      this.selectedEvent.set(ev);
      return;
    }
    const link = this.sectionLink(ev.stage);
    this.router.navigate(link.path, { queryParams: link.queryParams });
  }

  closeEventDetail(): void {
    this.selectedEvent.set(null);
  }

  // Flattened label/value rows for whatever's in ev.payload, used by
  // both the on-screen panel and the PDF below — kept in one place so
  // the two never drift apart.
  eventDetailRows(ev: HistoryEvent): Array<{ label: string; value: string }> {
    const p = (ev.payload ?? {}) as any;
    const rows: Array<{ label: string; value: string }> = [];
    const add = (label: string, value: unknown) => {
      if (value === undefined || value === null || value === '') return;
      rows.push({ label, value: String(value) });
    };

    switch (ev.stage) {
      case 'COMPLAINT':
        add('Complaint ID', p.complaintId);
        add('Category', p.category);
        add('Description', p.description);
        add('Status', p.status);
        add('Raised at', p.raisedAt);
        break;
      case 'FEEDBACK':
        add('Rating', p.rating ? `${p.rating}/5` : undefined);
        add('Comments', p.comments);
        add('Logged at', p.loggedAt);
        break;
      case 'SERVICE':
      case 'REPLACEMENT':
        add('Technician', p.technicianName);
        add('Technician phone', p.technicianPhone);
        add('Date', p.date);
        add('Resolution type', p.resolutionType);
        if (p.resolutionType === 'Repair') {
          add('Repair description', p.repair?.description);
          add('Repair remarks', p.repair?.remarks);
        }
        if (p.resolutionType === 'Replacement-Spare') {
          add('Part name', p.replacementSpare?.partName);
          add('Part cost', p.replacementSpare?.cost);
          add('Remarks', p.replacementSpare?.remarks);
        }
        if (p.resolutionType === 'Replacement-Device') {
          add('Old MAC ID', p.replacementDevice?.oldMacId);
          add('New MAC ID', p.replacementDevice?.newMacId);
          add('Replaced by', p.replacementDevice?.byWhom);
          add('Remarks', p.replacementDevice?.remarks);
        }
        if (p.amount) {
          add('Amount', p.amount.value);
          add('Payment status', p.amount.status);
        }
        add('Resolves complaint', p.complaintId);
        break;
    }
    return rows;
  }

  // One PDF per timeline entry, built straight from ev.payload — this
  // is what makes the download reflect the exact historical record
  // instead of whatever the live Monitoring & Service page happens to
  // show today.
  downloadEventDetailPdf(ev: HistoryEvent): void {
    const doc = new jsPDF();
    const marginX = 20;
    let y = 22;

    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text(`${ev.stage} — History Record`, marginX, y);
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
    row('Recorded at', ev.timestamp);
    row('Summary', ev.summary);
    for (const r of this.eventDetailRows(ev)) {
      row(r.label, r.value);
    }

    const safeTimestamp = ev.timestamp.replace(/[:.]/g, '-');
    downloadPdf(doc, `${ev.stage.toLowerCase()}-${safeTimestamp}-${this.macId}.pdf`)
      .catch((err) => console.error('PDF download failed', err));
  }
}
