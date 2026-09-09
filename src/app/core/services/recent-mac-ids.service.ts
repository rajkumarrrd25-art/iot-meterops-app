import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'meterops.recentMacIds';
const MAX_RECENT = 8;

// Keeps a small MRU list of MAC IDs the admin has looked up, so search
// boxes across the app can offer them instead of retyping every time.
// Backed by localStorage — purely a client-side convenience, never sent
// to the backend.
@Injectable({ providedIn: 'root' })
export class RecentMacIdsService {
  private ids = signal<string[]>(this.readFromStorage());

  list(): string[] {
    return this.ids();
  }

  add(macId: string): void {
    const trimmed = macId.trim();
    if (!trimmed) return;
    const next = [trimmed, ...this.ids().filter((id) => id.toLowerCase() !== trimmed.toLowerCase())].slice(
      0,
      MAX_RECENT,
    );
    this.ids.set(next);
    this.writeToStorage(next);
  }

  private readFromStorage(): string[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  }

  private writeToStorage(ids: string[]): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    } catch {
      // Storage unavailable (private browsing etc.) — fail silently,
      // recent-list is a convenience, not a requirement.
    }
  }
}
