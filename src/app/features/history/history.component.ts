import { Component, OnInit, computed, signal } from '@angular/core';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';
import { DeviceApiService } from '../../core/services/device-api.service';
import { HistoryEvent } from '../../core/models/device.model';

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

  constructor(private route: ActivatedRoute, private api: DeviceApiService) {}

  ngOnInit(): void {
    this.macId = this.route.snapshot.paramMap.get('macId') ?? '';
    this.loading.set(true);
    this.api.getHistory(this.macId).pipe(
      catchError(() => { this.notFound.set(true); return of([] as HistoryEvent[]); }),
    ).subscribe((events) => {
      this.events.set(events);
      this.loading.set(false);
    });
  }

  stageColor(stage: HistoryEvent['stage']): string {
    switch (stage) {
      case 'RECEIPT': return 'gray';
      case 'BOOKING': return 'purple';
      case 'INSTALLATION': return 'green';
      case 'SERVICE': return 'amber';
      case 'DISCONNECTION': return 'red';
      case 'REPLACEMENT': return 'blue';
      default: return 'gray';
    }
  }

  // Where a timeline entry should take you when clicked, in Operations.
  // RECEIPT has no dedicated /:section route (it lives on the Operations
  // page itself, behind the mac-header Edit button) so it deep-links
  // there with ?view=receipt instead of a section segment.
  sectionLink(stage: HistoryEvent['stage']): { path: any[]; queryParams?: Record<string, string> } {
    const base = ['/operations', this.macId];
    const readonly = { view: 'readonly' };
    switch (stage) {
      case 'RECEIPT': return { path: base, queryParams: { view: 'receipt' } };
      case 'BOOKING': return { path: [...base, 'booking-payment'], queryParams: readonly };
      case 'INSTALLATION': return { path: [...base, 'installation'], queryParams: readonly };
      case 'SERVICE': return { path: [...base, 'monitoring-service'], queryParams: readonly };
      case 'REPLACEMENT': return { path: [...base, 'monitoring-service'], queryParams: readonly };
      case 'DISCONNECTION': return { path: [...base, 'disconnection'], queryParams: readonly };
      default: return { path: base };
    }
  }
}
