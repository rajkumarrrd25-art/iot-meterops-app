import { Component, OnInit, computed, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DeviceApiService } from '../../core/services/device-api.service';
import { DeviceListItem } from '../../core/models/device.model';

// Single shared "all devices" list, used from two entry points:
//   /devices              -> mode 'operations' (default) — row click goes to /operations/:macId
//   /devices?for=history  -> mode 'history'               — row click goes to /history/:macId
// Also handles adding a brand-new MAC ID straight from the list (Step 1 of
// the lifecycle: add -> DB -> then fill in receipt/booking/etc. later).
@Component({
  selector: 'app-device-list',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './device-list.component.html',
  styleUrl: './device-list.component.css',
})
export class DeviceListComponent implements OnInit {
  mode: 'operations' | 'history' = 'operations';

  devices = signal<DeviceListItem[]>([]);
  loading = signal(true);
  loadError = signal<string | null>(null);

  search = '';
  newMacId = '';

  filtered = computed(() => {
    const q = this.search.trim().toLowerCase();
    const list = this.devices();
    if (!q) return list;
    return list.filter((d) => d.macId.toLowerCase().includes(q));
  });

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
        this.devices.set([...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
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

  stageColor(stage: DeviceListItem['stage']): string {
    switch (stage) {
      case 'Received': return 'blue';
      case 'Rejected': return 'red';
      case 'Booked': return 'purple';
      case 'Installed': return 'green';
      case 'Disconnected': return 'gray';
      default: return 'gray';
    }
  }
}
