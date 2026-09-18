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
  // Expressive verdict shown on each tile — a quick "is this fine or
  // does someone need to act on it" read at a glance, separate from the
  // tile's own accent color (which is fixed per-tile, not value-driven).
  // statusTone drives the corner badge + pill color/animation.
  // statusWord is a 1-2 word symbol-first label (kept short on purpose —
  // the icon carries the meaning, the word is just a caption for it).
  // statusText is the full sentence, kept as the title="" tooltip only.
  statusTone: 'good' | 'warn' | 'critical' | 'info';
  statusWord: string;
  statusText: string;
  // 0-100 ring fill for tiles where a proportion is the more honest
  // symbol than a red/green verdict (Installed, Running) — a ring reads
  // instantly without needing the number spelled out in words.
  ring?: number;
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
    const feedbackCount = s.customerFeedbackCount ?? 0;

    const installedPct = s.totalDevices ? Math.round((s.installed / s.totalDevices) * 100) : 0;
    const runningPct = s.installed ? Math.round((running / s.installed) * 100) : 0;

    // No devices on file at all yet — every "0 and therefore healthy"
    // tone below (Optimal/Clear/checkmark) would be misleading here,
    // since there's no fleet to have evaluated as healthy in the first
    // place. This short-circuits every derived tone/word/text to a
    // neutral "no data yet" state instead of a false-positive "good".
    const isEmpty = s.totalDevices === 0;

    // Devices exist but none have reached Installation yet (e.g. sitting
    // in stock) — Running/Missing's own "0 and therefore healthy" trap,
    // one step later in the lifecycle than isEmpty above. Without this,
    // installed === 0 falls through to missing === 0 (0 - 0 = 0) and
    // reads as "Fleet fully healthy" / "All devices online", which is
    // wrong: there's nothing installed to BE healthy or online.
    const noneInstalled = !isEmpty && s.installed === 0;

    // Stock + Booked read together: zero stock is only a problem if
    // there are bookings waiting on a device to hand out. Zero stock
    // with zero backlog just means the fleet is efficiently fully
    // deployed, not that something's wrong.
    const stockTone: DashboardTile['statusTone'] = isEmpty
      ? 'info'
      : s.currentStock === 0 && s.booked > 0
        ? 'warn'
        : 'good';
    const stockWord = isEmpty ? 'No data' : s.currentStock === 0 && s.booked > 0 ? 'Restock' : 'Optimal';
    const stockText = isEmpty
      ? 'No devices added yet'
      : s.currentStock === 0 && s.booked > 0
        ? 'Restock — bookings waiting'
        : s.currentStock === 0
          ? 'Fully deployed, no idle stock'
          : 'Ready to deploy';

    const bookedTone: DashboardTile['statusTone'] = isEmpty ? 'info' : s.booked > 0 ? 'warn' : 'good';
    const bookedWord = isEmpty ? 'No data' : s.booked > 0 ? 'Pending' : 'Clear';
    const bookedText = isEmpty ? 'No devices added yet' : s.booked > 0 ? 'Awaiting installation' : 'No backlog';

    const runningTone: DashboardTile['statusTone'] = isEmpty
      ? 'info'
      : noneInstalled
        ? 'info'
        : missing === 0
          ? 'good'
          : 'info';
    const runningWord = isEmpty ? '—' : noneInstalled ? '—' : `${runningPct}%`;
    const runningText = isEmpty
      ? 'No devices to monitor yet'
      : noneInstalled
        ? 'Nothing installed yet'
        : missing === 0
          ? 'Fleet fully healthy'
          : `${running} of ${s.installed} online`;

    const missingTone: DashboardTile['statusTone'] = isEmpty
      ? 'info'
      : noneInstalled
        ? 'info'
        : missing === 0
          ? 'good'
          : 'critical';
    const missingWord = isEmpty ? 'No data' : noneInstalled ? '—' : missing === 0 ? 'Clear' : 'Now';
    const missingText = isEmpty
      ? 'No devices added yet'
      : noneInstalled
        ? 'Nothing installed yet'
        : missing === 0
          ? 'All devices online'
          : 'Needs check now';

    const complaintsTone: DashboardTile['statusTone'] = isEmpty
      ? 'info'
      : noneInstalled
        ? 'info'
        : s.customerComplaintsCount === 0
          ? 'good'
          : 'critical';
    const complaintsWord = isEmpty
      ? 'No data'
      : noneInstalled
        ? '—'
        : s.customerComplaintsCount === 0
          ? 'Clear'
          : 'Now';
    const complaintsText = isEmpty
      ? 'No devices added yet'
      : noneInstalled
        ? 'Nothing installed yet'
        : s.customerComplaintsCount === 0
          ? 'All clear'
          : 'Action needed';

    // NOTE: feedbackCount here is "how many devices have at least
    // one feedback on file" (one device = one count, fixed on the
    // backend — see getDashboardSummary), not a running lifetime
    // total of every submission.
    //
    // Tone/word/text are now driven by badFeedbackCount specifically
    // (latest rating below 3★ per device), not just "any feedback
    // exists" — a device with only good ratings on file shouldn't
    // trip the red/critical flag. The status text spells out the
    // exact split instead of a flat "N devices with feedback".
    const badFeedbackCount = s.badFeedbackCount ?? 0;
    const goodFeedbackCount = s.goodFeedbackCount ?? 0;
    const feedbackTone: DashboardTile['statusTone'] = isEmpty
      ? 'info'
      : noneInstalled
        ? 'info'
        : badFeedbackCount > 0
          ? 'critical'
          : 'good';
    const feedbackWord = isEmpty ? 'No data' : noneInstalled ? '—' : badFeedbackCount > 0 ? 'Now' : 'Clear';
    const feedbackText = isEmpty
      ? 'No devices added yet'
      : noneInstalled
        ? 'Nothing installed yet'
        : feedbackCount === 0
          ? 'No feedback pending review'
          : `${badFeedbackCount} bad (below 3★), ${goodFeedbackCount} good (5★)`;

    const feedbackSub = isEmpty || noneInstalled || feedbackCount === 0
      ? 'Devices with feedback'
      : `${badFeedbackCount} bad (<3★) · ${goodFeedbackCount} good (5★)`;

    return [
      { key: 'total', label: 'Total devices', value: s.totalDevices, sub: 'Lifetime count', color: 'blue', icon: 'devices', statusTone: 'info', statusWord: 'Fleet', statusText: 'Fleet size' },
      { key: 'installed', label: 'Installed', value: s.installed, sub: 'Field deployed', color: 'green', icon: 'pin', statusTone: 'info', statusWord: isEmpty ? '—' : `${installedPct}%`, statusText: isEmpty ? 'No devices added yet' : `${installedPct}% of fleet deployed`, ring: installedPct },
      { key: 'stock', label: 'Current stock', value: s.currentStock, sub: 'Ready in inventory', color: 'gray', icon: 'package', statusTone: stockTone, statusWord: stockWord, statusText: stockText },
      { key: 'booked', label: 'Booked', value: s.booked, sub: 'Awaiting deployment', color: 'purple', icon: 'calendar', statusTone: bookedTone, statusWord: bookedWord, statusText: bookedText },
      { key: 'running', label: 'Running', value: running, sub: 'Active and healthy', color: 'green', icon: 'activity', statusTone: runningTone, statusWord: runningWord, statusText: runningText, ring: runningPct },
      { key: 'missing', label: 'Missing / offline', value: missing, sub: 'Needs check', color: 'amber', icon: 'wifi-off', statusTone: missingTone, statusWord: missingWord, statusText: missingText },
      { key: 'complaints', label: 'Complaints', value: s.customerComplaintsCount, sub: 'Immediate action', color: 'red', icon: 'alert', statusTone: complaintsTone, statusWord: complaintsWord, statusText: complaintsText },
      { key: 'feedback', label: 'Customer feedback', value: feedbackCount, sub: feedbackSub, color: 'purple', icon: 'feedback', statusTone: feedbackTone, statusWord: feedbackWord, statusText: feedbackText },
    ];
  });

  // SVG stroke-dashoffset for a ring icon of given radius — used by
  // Installed/Running's mini progress ring (a proportion reads faster
  // as a ring than as a red/green verdict badge would).
  ringOffset(pct: number, radius = 15): number {
    const circumference = 2 * Math.PI * radius;
    const clamped = Math.max(0, Math.min(100, pct));
    return circumference - (clamped / 100) * circumference;
  }

  ringCircumference(radius = 15): number {
    return 2 * Math.PI * radius;
  }

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