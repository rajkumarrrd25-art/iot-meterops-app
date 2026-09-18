import { Component, ElementRef, EventEmitter, HostListener, Input, Output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

// Self-contained calendar dropdown that replaces native <input type="date">.
// Built because the native OS picker was unreliable on some setups (opens
// then immediately closes when clicking inside it to change month) — this
// version renders and handles its own popup entirely in-app, so it behaves
// identically everywhere regardless of OS/browser picker quirks.
//
// Usage: [value]="isoDateStringOrEmpty" (valueChange)="handler($event)"
// Emits/accepts plain 'YYYY-MM-DD' strings, same shape the rest of the app
// (DeviceListComponent.fromDate/toDate) already works with.
interface DayCell {
  day: number;
  iso: string;
}

@Component({
  selector: 'app-date-picker',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './date-picker.component.html',
  styleUrl: './date-picker.component.css',
})
export class DatePickerComponent {
  @Input()
  set value(v: string | null | undefined) {
    this._value.set(v || '');
  }
  get value(): string {
    return this._value();
  }

  @Input() placeholder = 'mm/dd/yyyy';
  @Output() valueChange = new EventEmitter<string>();

  readonly weekdayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  private _value = signal('');
  open = signal(false);
  viewYear = signal(new Date().getFullYear());
  viewMonth = signal(new Date().getMonth()); // 0-11

  // When the wrapper sits close enough to the right edge of the viewport
  // that the 240px-wide panel (opened left-aligned by default) would spill
  // off-screen or get clipped by an ancestor's overflow, we flip it to
  // hang from the right edge of the input instead.
  alignRight = signal(false);
  private static readonly PANEL_WIDTH = 240;

  constructor(private el: ElementRef<HTMLElement>) {}

  // Close the panel on any click outside this component — without this the
  // panel would stay open forever since it's not a native popup anymore.
  @HostListener('document:click', ['$event'])
  onDocumentClick(e: MouseEvent): void {
    if (this.open() && !this.el.nativeElement.contains(e.target as Node)) {
      this.open.set(false);
    }
  }

  togglePanel(): void {
    if (!this.open()) {
      const base = this._value() ? this.parseIso(this._value()) : new Date();
      this.viewYear.set(base.getFullYear());
      this.viewMonth.set(base.getMonth());
      this.updateAlignment();
    }
    this.open.update((o) => !o);
  }

  // Decide whether the panel needs to hang from the right edge instead of
  // the left. Based on the wrapper's own position, so it works whether the
  // clipping comes from the browser viewport or a scrollable ancestor panel.
  private updateAlignment(): void {
    const rect = this.el.nativeElement.getBoundingClientRect();
    const wouldOverflow = rect.left + DatePickerComponent.PANEL_WIDTH > window.innerWidth;
    this.alignRight.set(wouldOverflow);
  }

  prevMonth(e: Event): void {
    e.stopPropagation();
    let m = this.viewMonth() - 1;
    let y = this.viewYear();
    if (m < 0) {
      m = 11;
      y -= 1;
    }
    this.viewMonth.set(m);
    this.viewYear.set(y);
  }

  nextMonth(e: Event): void {
    e.stopPropagation();
    let m = this.viewMonth() + 1;
    let y = this.viewYear();
    if (m > 11) {
      m = 0;
      y += 1;
    }
    this.viewMonth.set(m);
    this.viewYear.set(y);
  }

  get monthLabel(): string {
    return new Date(this.viewYear(), this.viewMonth(), 1).toLocaleString('default', {
      month: 'long',
      year: 'numeric',
    });
  }

  // 6 rows x 7 cols grid (nulls for leading/trailing blanks) for the current
  // viewYear/viewMonth — recomputed on every access, which is fine at this
  // scale (42 cells) and keeps the component free of manual cache-busting.
  get weeks(): Array<Array<DayCell | null>> {
    const year = this.viewYear();
    const month = this.viewMonth();
    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const cells: Array<DayCell | null> = [];
    for (let i = 0; i < firstDow; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ day: d, iso: this.toIso(year, month, d) });
    }
    while (cells.length % 7 !== 0) cells.push(null);

    const weeks: Array<Array<DayCell | null>> = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }

  selectDay(cell: DayCell | null, e: Event): void {
    e.stopPropagation();
    if (!cell) return;
    this._value.set(cell.iso);
    this.valueChange.emit(cell.iso);
    this.open.set(false);
  }

  clear(e: Event): void {
    e.stopPropagation();
    this._value.set('');
    this.valueChange.emit('');
    this.open.set(false);
  }

  isSelected(iso: string): boolean {
    return this._value() === iso;
  }

  isToday(iso: string): boolean {
    const t = new Date();
    return iso === this.toIso(t.getFullYear(), t.getMonth(), t.getDate());
  }

  get displayLabel(): string {
    if (!this._value()) return '';
    const [y, m, d] = this._value().split('-');
    return `${m}/${d}/${y}`;
  }

  private toIso(year: number, month0: number, day: number): string {
    return `${year}-${String(month0 + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  private parseIso(iso: string): Date {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }
}
