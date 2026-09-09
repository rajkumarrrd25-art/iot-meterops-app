import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { DeviceApiService } from '../../core/services/device-api.service';
import { AuthService } from '../../core/services/auth.service';
import { RecentMacIdsService } from '../../core/services/recent-mac-ids.service';
import {
  LiveDeviceStatusService,
  LIVE_STATUS_POLL_INTERVAL_MS,
} from '../../core/services/live-device-status.service';
import { normalizeMacId, MAC_ID_FORMAT_ERROR } from '../../core/utils/mac-id.util';
import { DashboardSummary } from '../../core/models/device.model';

interface DashboardTile {
  key: string;
  label: string;
  value: number;
  sub: string;
  color: 'blue' | 'gray' | 'purple' | 'green' | 'amber' | 'red';
  icon: string;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.css',
})
export class DashboardComponent implements OnInit, OnDestroy {
  summary = signal<DashboardSummary | null>(null);
  operationsMacId = '';
  historyMacId = '';

  // Running / Missing-Offline, derived LIVE from the same device-monitoring
  // API/logic App 1 uses (see LiveDeviceStatusService) — NOT from the
  // backend summary's CURRENT_STATUS-based counts, and NEVER from
  // complaints/service/feedback data. null while the first live check for
  // this session hasn't completed yet, in which case the tiles fall back
  // to the backend summary's counts so the dashboard never shows a blank.
  liveRunningCount = signal<number | null>(null);
  private liveStatusIntervalId?: ReturnType<typeof setInterval>;

  // Signed-in user + a live clock for the top bar.
  userEmail = signal<string | null>(null);
  userRole = signal<string | null>(null);
  now = signal(new Date());
  private clockHandle?: ReturnType<typeof setInterval>;

  userName = computed(() => {
    const email = this.userEmail();
    return email ? email.split('@')[0] : '';
  });

  userInitials = computed(() => {
    const name = this.userName();
    if (!name) return '';
    const parts = name.split(/[._-]/).filter(Boolean);
    const first = parts[0]?.[0] ?? '';
    const second = parts[1]?.[0] ?? name[1] ?? '';
    return (first + second).toUpperCase();
  });

  tiles = computed<DashboardTile[]>(() => {
    const s = this.summary();
    if (!s) return [];

    // Installed = Running + Missing/Offline, always — Missing/Offline is
    // never a separately-maintained number. Both are driven by
    // liveRunningCount once the first live sweep resolves; until then we
    // fall back to the backend summary's counts rather than show 0/blank.
    const live = this.liveRunningCount();
    const running = live ?? s.runningCount;
    const missing = live !== null ? Math.max(s.installed - live, 0) : s.missingCount;

    return [
      { key: 'total', label: 'Total devices', value: s.totalDevices, sub: 'Lifetime count', color: 'blue', icon: 'devices' },
      { key: 'installed', label: 'Installed', value: s.installed, sub: 'Field deployed', color: 'green', icon: 'pin' },
      { key: 'stock', label: 'Current stock', value: s.currentStock, sub: 'Ready in inventory', color: 'gray', icon: 'package' },
      { key: 'booked', label: 'Booked', value: s.booked, sub: 'Awaiting deployment', color: 'purple', icon: 'calendar' },
      { key: 'running', label: 'Running', value: running, sub: 'Active and healthy', color: 'green', icon: 'activity' },
      { key: 'missing', label: 'Missing / offline', value: missing, sub: 'Needs check', color: 'amber', icon: 'wifi-off' },
      { key: 'complaints', label: 'Complaints', value: s.customerComplaintsCount, sub: 'Immediate action', color: 'red', icon: 'alert' },
      { key: 'feedback', label: 'Customer feedback', value: s.customerFeedbackCount ?? 0, sub: 'New submissions', color: 'purple', icon: 'feedback' },
    ];
  });

  constructor(
    private api: DeviceApiService,
    private router: Router,
    private auth: AuthService,
    private recentMacIds: RecentMacIdsService,
    private liveStatus: LiveDeviceStatusService,
  ) {}

  recentIds(): string[] {
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const raw of this.recentMacIds.list()) {
      const normalized = normalizeMacId(raw);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        clean.push(normalized);
      }
    }
    return clean;
  }

  opsDropdownOpen = signal(false);
  historyDropdownOpen = signal(false);
  opsError = signal<string | null>(null);
  historyError = signal<string | null>(null);

  // Small delay so a (mousedown) on a dropdown item registers before the
  // input's (blur) closes the dropdown out from under it.
  closeOpsDropdownSoon(): void {
    setTimeout(() => this.opsDropdownOpen.set(false), 150);
  }
  closeHistoryDropdownSoon(): void {
    setTimeout(() => this.historyDropdownOpen.set(false), 150);
  }

  ngOnInit(): void {
    this.api.getDashboardSummary().subscribe((s) => this.summary.set(s));
    this.userEmail.set(this.auth.getUserEmail());
    this.userRole.set(this.auth.getRole());
    this.clockHandle = setInterval(() => this.now.set(new Date()), 1000);
    this.startLiveFleetPolling();
  }

  ngOnDestroy(): void {
    if (this.clockHandle) clearInterval(this.clockHandle);
    this.stopLiveFleetPolling();
  }

  // =====================================================
  // LIVE FLEET STATUS (Running / Missing-Offline tiles)
  // Same polling cadence as App 1's live voltage tracker (60s), using the
  // same device-monitoring API/logic — see LiveDeviceStatusService.
  // =====================================================

  private startLiveFleetPolling(): void {
    this.stopLiveFleetPolling();

    this.refreshLiveFleetStatus();

    this.liveStatusIntervalId = setInterval(() => {
      if (document.hidden) return;
      this.refreshLiveFleetStatus();
    }, LIVE_STATUS_POLL_INTERVAL_MS);
  }

  private stopLiveFleetPolling(): void {
    if (this.liveStatusIntervalId !== undefined) {
      clearInterval(this.liveStatusIntervalId);
      this.liveStatusIntervalId = undefined;
    }
  }

  private refreshLiveFleetStatus(): void {
    this.api.listDevices().subscribe((devices) => {
      const installedMacIds = devices
        .filter((d) => d.installationStatus === 'Completed')
        .map((d) => d.macId);

      if (installedMacIds.length === 0) {
        this.liveRunningCount.set(0);
        return;
      }

      this.liveStatus.getFleetStatus(installedMacIds).subscribe((results) => {
        const running = results.filter((r) => r.online).length;
        this.liveRunningCount.set(running);
      });
    });
  }

  goToOperations(): void {
    const normalized = normalizeMacId(this.operationsMacId);
    if (!normalized) {
      this.opsError.set(MAC_ID_FORMAT_ERROR);
      return;
    }
    this.opsError.set(null);
    this.recentMacIds.add(normalized);
    this.router.navigate(['/operations', normalized]);
  }

  goToHistory(): void {
    const normalized = normalizeMacId(this.historyMacId);
    if (!normalized) {
      this.historyError.set(MAC_ID_FORMAT_ERROR);
      return;
    }
    this.historyError.set(null);
    this.recentMacIds.add(normalized);
    this.router.navigate(['/history', normalized]);
  }

  async logout(): Promise<void> {
    await this.auth.logout();
  }
}