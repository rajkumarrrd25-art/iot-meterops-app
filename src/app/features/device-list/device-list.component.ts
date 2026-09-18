import { Component, OnInit, computed, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DeviceApiService } from '../../core/services/device-api.service';
import { DeviceListItem } from '../../core/models/device.model';
import { DatePickerComponent } from '../../shared/date-picker/date-picker.component';

// Single shared "all devices" list, used from two entry points:
//   /devices              -> mode 'operations' (default) — row click goes to /operations/:macId
//   /devices?for=history  -> mode 'history'               — row click goes to /history/:macId
// Also handles adding a brand-new MAC ID straight from the list (Step 1 of
// the lifecycle: add -> DB -> then fill in receipt/booking/etc. later).
@Component({
  selector: 'app-device-list',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, DatePickerComponent],
  templateUrl: './device-list.component.html',
  styleUrl: './device-list.component.css',
})
export class DeviceListComponent implements OnInit {
  mode: 'operations' | 'history' = 'operations';

  // Full unfiltered list — fetched once on load. Only used for the "no
  // devices added yet" empty-state and as the total in "Showing X of Y".
  devices = signal<DeviceListItem[]>([]);
  // What's actually rendered. With no filters active this is the same
  // array as `devices`; with filters active it's the result of a
  // server-side filtered request (see applyFilters below) — the backend
  // does the Scan + merge either way, but a filtered request only ships
  // matching rows back, so payload/render work shrinks as the fleet grows.
  displayed = signal<DeviceListItem[]>([]);
  loading = signal(true);
  loadError = signal<string | null>(null);

  newMacId = '';

  // Filters — fleet-wide analysis by stage + period. No free-text search
  // here on purpose: this list is for slicing the fleet by stage and a
  // date range (e.g. "how many Complaint devices in August"), not for
  // hunting a single MAC ID/customer (use the dashboard's MAC ID lookup
  // for that instead).
  stageFilter = signal<DeviceListItem['stage'] | 'All'>('All');
  fromDate = signal('');
  toDate = signal('');

  // 'Rejected' is intentionally left out of the analysis buckets (it's a
  // terminal intake outcome, not a fleet-analysis stage) but still shows
  // up in the list itself, and under 'All stages'.
  readonly stageOptions: Array<DeviceListItem['stage'] | 'All'> =
    ['All', 'Instock', 'Booked', 'Active', 'Disconnected', 'Complaint'];

  hasActiveFilters = computed(() =>
    this.stageFilter() !== 'All' || !!this.fromDate() || !!this.toDate(),
  );

  onStageChange(stage: DeviceListItem['stage'] | 'All'): void {
    this.stageFilter.set(stage);
    this.applyFilters();
  }

  onFromChange(from: string): void {
    this.fromDate.set(from);
    this.applyFilters();
  }

  onToChange(to: string): void {
    this.toDate.set(to);
    this.applyFilters();
  }

  clearFilters(): void {
    this.stageFilter.set('All');
    this.fromDate.set('');
    this.toDate.set('');
    this.applyFilters();
  }

  // Re-fetches from the server with the current filter values. With no
  // filters active, no extra request is needed — the already-fetched
  // unfiltered `devices` list is exactly right.
  applyFilters(): void {
    const stage = this.stageFilter();
    const from = this.fromDate();
    const to = this.toDate();

    if (stage === 'All' && !from && !to) {
      this.displayed.set(this.devices());
      return;
    }

    this.loading.set(true);
    this.loadError.set(null);
    this.api.listDevices({ stage, from, to }).subscribe({
      next: (list) => {
        const sorted = [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        this.displayed.set(sorted);
        this.loading.set(false);
      },
      error: () => {
        this.loadError.set('Could not load the device list. Check your connection and try again.');
        this.loading.set(false);
      },
    });
  }

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private api: DeviceApiService,
  ) {}

  ngOnInit(): void {
    this.mode = this.route.snapshot.queryParamMap.get('for') === 'history' ? 'history' : 'operations';
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.api.listDevices().subscribe({
      next: (list) => {
        // Newest first — the device most recently added/updated is what
        // you're usually looking for right after adding it.
        const sorted = [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        this.devices.set(sorted);
        this.displayed.set(sorted);
        this.loading.set(false);
      },
      error: () => {
        this.loadError.set('Could not load the device list. Check your connection and try again.');
        this.loading.set(false);
      },
    });
  }

  open(macId: string): void {
    if (this.mode === 'history') {
      this.router.navigate(['/history', macId]);
    } else {
      this.router.navigate(['/operations', macId]);
    }
  }

  // Jump into the Operations page for a brand-new MAC ID — that page now
  // owns the actual "add device" step (it captures receipt/stock intake
  // details as part of adding), so this just routes there.
  addNew(): void {
    const macId = this.newMacId.trim();
    if (!macId) return;
    this.router.navigate(['/operations', macId]);
  }

  // Badge label — used to just be `d.stage` conditionally overridden to
  // 'Active' only when a separate live-telemetry ping said the device
  // was online RIGHT NOW. That made the badge flicker between 'Service'
  // and 'Active' depending on a live connectivity check that has nothing
  // to do with the lifecycle stage itself — a device whose installation
  // is Completed is Active in its lifecycle whether or not it happens to
  // answer a ping at this exact moment. `stage` is already 'Active' as
  // soon as installation completes (see backend getDeviceList()), so
  // this is now just a passthrough; live on/off status has its own
  // dedicated home in the Dashboard's Running/Missing-Offline tiles.
  displayStage(d: DeviceListItem): string {
    return d.stage;
  }

  stageColor(stage: string): string {
    switch (stage) {
      case 'Instock': return 'blue';
      case 'Booked': return 'purple';
      case 'Active': return 'green';
      case 'Disconnected': return 'gray';
      case 'Complaint': return 'red';
      case 'Rejected': return 'red';
      default: return 'gray';
    }
  }
}