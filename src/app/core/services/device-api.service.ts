import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from './auth.service';
import {
  DashboardSummary,
  DeviceListItem,
  DeviceRecord,
  ReceiptRecord,
  BookingPaymentRecord,
  InstallationRecord,
  MonitoringServiceRecord,
  ServiceRecord,
  DisconnectionRecord,
  CurrentStatusRecord,
  HistoryEvent,
  CustomerFeedback,
  AvailableOperationsResponse,
} from '../models/device.model';

@Injectable({ providedIn: 'root' })
export class DeviceApiService {
  private base = environment.apiBaseUrl;

  constructor(private http: HttpClient, private auth: AuthService) {}

  private authHeaders(): HttpHeaders {
    return new HttpHeaders({
      Authorization: `Bearer ${this.auth.getIdToken() ?? ''}`,
    });
  }

  private url(path: string, macId?: string): string {
    const p = macId ? path.replace('{macId}', encodeURIComponent(macId)) : path;
    return `${this.base}${p}`;
  }

  // ---- Dashboard ----
  getDashboardSummary(): Observable<DashboardSummary> {
    return this.http.get<DashboardSummary>(
      this.url(environment.endpoints.dashboardSummary),
      { headers: this.authHeaders() },
    );
  }

  // ---- All devices (list page used by both Operations and History) ----
  // Filters are optional and applied server-side (post-merge — `stage`
  // isn't a stored attribute, see index.js). Called with no args this is
  // unchanged from before — the Dashboard's live-status tiles rely on
  // getting the full unfiltered list, so that call site is untouched.
  listDevices(filters?: { stage?: string; from?: string; to?: string }): Observable<DeviceListItem[]> {
    let params = new HttpParams();
    if (filters?.stage && filters.stage !== 'All') params = params.set('stage', filters.stage);
    if (filters?.from) params = params.set('from', filters.from);
    if (filters?.to) params = params.set('to', filters.to);

    return this.http.get<DeviceListItem[]>(this.url(environment.endpoints.devicesList), {
      headers: this.authHeaders(),
      params,
    });
  }

  // ---- Which operations have data for this MAC ID (drives dropdown enable/disable) ----
  // Backend returns { sections, bookingStatus, installationStatus } — NOT a bare
  // string[] — since bookingStatus/installationStatus were added so the
  // Operations grid can eventually show the real record state (e.g.
  // "Confirmed" vs "Pending") instead of a flat "on file" badge. Keep this
  // typed to the actual shape; unwrapping .sections is the caller's job
  // (see operations.component.ts loadAvailable()) — handing the raw
  // response straight to `new Set(...)` as if it were still a string[]
  // throws, since a plain object has no iterator, which is exactly what
  // was silently breaking every stage-lock check past Booking + payment.
  getAvailableOperations(macId: string): Observable<AvailableOperationsResponse> {
    return this.http.get<AvailableOperationsResponse>(
      this.url(environment.endpoints.deviceOperations, macId),
      { headers: this.authHeaders() },
    );
  }

  // ---- Device existence ----
  // NOTE: there is no bare `/devices/{macId}` route in API Gateway or the
  // Lambda (no method configured on that resource, no handler for that
  // path) — calling it 404s before even reaching Lambda. A device's
  // existence is established the moment its RECEIPT item is written, and
  // the dashboard summary already counts a macId as soon as ANY item
  // exists for it — so we piggyback on the receipt endpoint instead of a
  // separate bare-record endpoint. GET fails/404 => the MAC ID has never
  // been added. Used by the Operations page to decide whether to show
  // "Add device" or the normal section grid.
  checkDevice(macId: string): Observable<DeviceRecord> {
    return this.http.get<ReceiptRecord>(this.url(environment.endpoints.receipt, macId), {
      headers: this.authHeaders(),
    }) as unknown as Observable<DeviceRecord>;
  }

  // ---- Receipt ----
  getReceipt(macId: string): Observable<ReceiptRecord> {
    return this.http.get<ReceiptRecord>(this.url(environment.endpoints.receipt, macId), {
      headers: this.authHeaders(),
    });
  }
  saveReceipt(record: ReceiptRecord): Observable<ReceiptRecord> {
    return this.http.put<ReceiptRecord>(
      this.url(environment.endpoints.receipt, record.macId),
      record,
      { headers: this.authHeaders() },
    );
  }

  // ---- Booking + Payment ----
  getBookingPayment(macId: string): Observable<BookingPaymentRecord> {
    return this.http.get<BookingPaymentRecord>(
      this.url(environment.endpoints.bookingPayment, macId),
      { headers: this.authHeaders() },
    );
  }
  saveBookingPayment(record: BookingPaymentRecord): Observable<BookingPaymentRecord> {
    return this.http.put<BookingPaymentRecord>(
      this.url(environment.endpoints.bookingPayment, record.macId),
      record,
      { headers: this.authHeaders() },
    );
  }

  // ---- Installation ----
  getInstallation(macId: string): Observable<InstallationRecord> {
    return this.http.get<InstallationRecord>(
      this.url(environment.endpoints.installation, macId),
      { headers: this.authHeaders() },
    );
  }
  saveInstallation(record: InstallationRecord): Observable<InstallationRecord> {
    return this.http.put<InstallationRecord>(
      this.url(environment.endpoints.installation, record.macId),
      record,
      { headers: this.authHeaders() },
    );
  }

  // ---- Monitoring & Service (includes complaints, view-only from customer app) ----
  getMonitoringService(macId: string): Observable<MonitoringServiceRecord> {
    return this.http.get<MonitoringServiceRecord>(
      this.url(environment.endpoints.monitoringService, macId),
      { headers: this.authHeaders() },
    );
  }
  saveService(macId: string, record: ServiceRecord): Observable<ServiceRecord> {
    return this.http.post<ServiceRecord>(
      this.url(environment.endpoints.monitoringService, macId) + '/service',
      record,
      { headers: this.authHeaders() },
    );
  }

  // ---- Disconnection ----
  getDisconnection(macId: string): Observable<DisconnectionRecord> {
    return this.http.get<DisconnectionRecord>(
      this.url(environment.endpoints.disconnection, macId),
      { headers: this.authHeaders() },
    );
  }
  saveDisconnection(record: DisconnectionRecord): Observable<DisconnectionRecord> {
    return this.http.put<DisconnectionRecord>(
      this.url(environment.endpoints.disconnection, record.macId),
      record,
      { headers: this.authHeaders() },
    );
  }

  // ---- Current Status (read-only, derived server-side) ----
  getCurrentStatus(macId: string): Observable<CurrentStatusRecord> {
    return this.http.get<CurrentStatusRecord>(
      this.url(environment.endpoints.currentStatus, macId),
      { headers: this.authHeaders() },
    );
  }

  // ---- Device History (read-only, GET only — no PUT/POST/DELETE ever) ----
  getHistory(macId: string): Observable<HistoryEvent[]> {
    return this.http.get<HistoryEvent[]>(
      this.url(environment.endpoints.history, macId),
      { headers: this.authHeaders() },
    );
  }

  // ---- Delete device (removes every record for this MAC ID) ----
  deleteDevice(macId: string): Observable<void> {
    return this.http.delete<void>(this.url(environment.endpoints.device, macId), {
      headers: this.authHeaders(),
    });
  }

  // ---- Customer feedback (read-only here — written by the customer app) ----
  getCustomerFeedback(macId: string): Observable<CustomerFeedback[]> {
    return this.http.get<CustomerFeedback[]>(
      this.url(environment.endpoints.customerFeedback, macId),
      { headers: this.authHeaders() },
    );
  }
}
