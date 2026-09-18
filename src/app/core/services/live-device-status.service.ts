import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map, timeout } from 'rxjs/operators';
import { environment } from '../../../environments/environment';

/**
 * Reuses the EXACT same live device-monitoring API and online/offline rule
 * that App 1 (IoT Energy Monitoring Dashboard) already uses in
 * live-voltage-tracker + energy-data.service.ts.
 *
 * DO NOT duplicate/re-derive device status from booking, installation,
 * disconnection, complaints or service records here — this service is the
 * single source of truth for "is this physical device ON/OFF right now"
 * for BOTH apps, so App 1 and App 2 can never disagree about a device's
 * live state.
 *
 * If this API's origin/CORS ever needs to be opened up for App 2's
 * domain, that's a backend (API Gateway) config change — no client logic
 * here should change to work around it.
 */

// Same endpoint as App 1's EnergyDataService.deviceApiUrl.
// Value lives in environment.ts (liveDeviceApiUrl) — see comment there for
// why it's separate from apiBaseUrl.
const LIVE_DEVICE_API_URL = environment.liveDeviceApiUrl;

// Same threshold as App 1's LiveVoltageTracker.isOnline(): a device is
// only considered ON if its last reported reading is under 2 minutes old.
const OFFLINE_THRESHOLD_MS = 2 * 60 * 1000;

// Same cadence as App 1's startLiveVoltagePolling() (60 sec).
export const LIVE_STATUS_POLL_INTERVAL_MS = 60 * 1000;

// Same guard App 1 uses on its "full" fetch so a genuinely offline meter
// doesn't hang a request forever.
const LIVE_FETCH_TIMEOUT_MS = 15000;

export interface LiveDeviceStatus {
  macId: string;
  online: boolean;
  timestamp: number | null; // last genuine reading time, ms epoch
  // True once the live API has actually answered for this macId — even
  // if the answer is "never reported, timestamp null". False only when
  // the call itself errored/timed out (network hiccup, backend down),
  // which is the one case that should NOT be treated as "found" yet.
  // Without this, a genuine self-installed device that has simply never
  // sent a reading was indistinguishable from an actual API failure —
  // both collapsed to timestamp:null — so "found, currently Off" and
  // "couldn't even check" were wrongly treated the same way.
  resolved: boolean;
}

@Injectable({ providedIn: 'root' })
export class LiveDeviceStatusService {
  constructor(private http: HttpClient) {}

  /** Same online/offline rule as App 1 — kept in exactly one place. */
  private isOnline(timestamp: number | null | undefined): boolean {
    if (!timestamp) return false;
    return Date.now() - timestamp < OFFLINE_THRESHOLD_MS;
  }

  /** Live status for a single device, via the same API App 1 uses. */
  getStatus(macId: string): Observable<LiveDeviceStatus> {
    return this.http
      .post<any>(LIVE_DEVICE_API_URL, { macid: macId, mode: 'live' })
      .pipe(
        timeout(LIVE_FETCH_TIMEOUT_MS),
        map((response) => {
          const live = response?.liveVoltage ?? response;
          const timestamp: number | null = live?.timestamp ?? null;
          return { macId, online: this.isOnline(timestamp), timestamp, resolved: true };
        }),
        // A device that never responds (power-cut, never installed, API
        // hiccup) is simply Offline — not an app error. resolved:false
        // is what tells callers this was an actual failure, not a
        // legitimate "never reported" reading.
        catchError(() => of({ macId, online: false, timestamp: null, resolved: false })),
      );
  }

  /**
   * Live status for many devices at once (used by the Fleet Overview
   * Running / Missing-Offline tiles). Each device is checked
   * independently so one slow/offline device never blocks the rest.
   */
  getFleetStatus(macIds: string[]): Observable<LiveDeviceStatus[]> {
    if (macIds.length === 0) return of([]);
    return forkJoin(macIds.map((id) => this.getStatus(id)));
  }
}
