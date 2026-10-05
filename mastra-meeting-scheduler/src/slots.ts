/**
 * Calendar arithmetic, in plain TypeScript and without a model anywhere near
 * it. A language model is good at reading "Thursday after lunch works" and
 * bad at knowing whether Thursday 14:00 is free, so the model only ever turns
 * words into time windows; which slots exist, which are free and which one is
 * booked is decided here.
 *
 * The availability file stands in for a calendar. Swap `loadBusy()` for a
 * Google Calendar or Cal.com lookup and nothing else changes.
 */

import { readFileSync } from "node:fs";

export interface Slot {
  /** ISO 8601, UTC. */
  start: string;
  end: string;
}

export interface Availability {
  /** IANA zone the working hours are written in, e.g. "Europe/London". */
  timezone: string;
  /** Working hours per weekday, "HH:MM-HH:MM", in `timezone`. */
  hours: Partial<Record<Weekday, string[]>>;
  /** Fixed commitments, ISO 8601 with an offset. */
  busy?: Slot[];
  /** Never offer a slot that starts sooner than this. */
  min_notice_hours?: number;
  /** Never offer a slot further out than this. */
  horizon_days?: number;
  /** Slots start on this grid. */
  step_minutes?: number;
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export function loadAvailability(path: string): Availability {
  return JSON.parse(readFileSync(path, "utf8")) as Availability;
}


// ---------------------------------------------------------------- time zones

/** Minutes the zone is ahead of UTC at `at` (BST is +60). */
export function tzOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / MINUTE);
}

/** The UTC instant of wall-clock `hhmm` on `ymd` in `timeZone`. */
export function zonedToUtc(ymd: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const [h, min] = hhmm.split(":").map(Number);
  const naive = Date.UTC(y, m - 1, d, h, min);
  // Two passes settle the offset on either side of a DST change.
  let guess = naive - tzOffsetMinutes(new Date(naive), timeZone) * MINUTE;
  guess = naive - tzOffsetMinutes(new Date(guess), timeZone) * MINUTE;
  return new Date(guess);
}

/** The calendar date and weekday of `at` in `timeZone`. */
export function localDay(at: Date, timeZone: string): { ymd: string; weekday: Weekday } {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const [y, m, d] = ymd.split("-").map(Number);
  return { ymd, weekday: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] };
}

// ---------------------------------------------------------------- slots

function overlaps(a: Slot, b: Slot): boolean {
  return Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Every free slot of `durationMinutes` between `now + min_notice` and the
 * horizon, on the step grid, inside working hours, clear of `busy`.
 */
export function freeSlots(av: Availability, busy: Slot[], durationMinutes: number, now: Date): Slot[] {
  const step = (av.step_minutes ?? 30) * MINUTE;
  const earliest = now.getTime() + (av.min_notice_hours ?? 12) * 60 * MINUTE;
  const latest = now.getTime() + (av.horizon_days ?? 10) * DAY;
  const blocked = [...(av.busy ?? []), ...busy];
  const out: Slot[] = [];

  // Walk calendar days in the organiser's zone; noon UTC never skips a date.
  const seen = new Set<string>();
  for (let t = now.getTime() - DAY; t <= latest + DAY; t += DAY / 2) {
    const { ymd, weekday } = localDay(new Date(t), av.timezone);
    if (seen.has(ymd)) continue;
    seen.add(ymd);
    for (const range of av.hours[weekday] ?? []) {
      const [from, to] = range.split("-");
      const open = zonedToUtc(ymd, from, av.timezone).getTime();
      const close = zonedToUtc(ymd, to, av.timezone).getTime();
      for (let s = open; s + durationMinutes * MINUTE <= close; s += step) {
        if (s < earliest || s > latest) continue;
        const slot = { start: iso(s), end: iso(s + durationMinutes * MINUTE) };
        if (!blocked.some((b) => overlaps(slot, b))) out.push(slot);
      }
    }
  }
  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/**
 * Up to `n` slots to offer, earliest first but on different days where the
 * calendar allows: three slots on one morning give the other person one real
 * choice, not three.
 */
export function pickOffer(free: Slot[], n = 3, avoid: Slot[] = [], timeZone = "UTC"): Slot[] {
  const candidates = free.filter((s) => !avoid.some((a) => a.start === s.start));
  const picked: Slot[] = [];
  const days = new Set<string>();
  for (const s of candidates) {
    if (picked.length >= n) break;
    const day = localDay(new Date(s.start), timeZone).ymd;
    if (days.has(day)) continue;
    days.add(day);
    picked.push(s);
  }
  for (const s of candidates) {
    if (picked.length >= n) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return picked.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** Free slots lying wholly inside one of the windows the other person named. */
export function slotsWithin(free: Slot[], windows: Slot[]): Slot[] {
  const valid = windows.filter((w) => !Number.isNaN(Date.parse(w.start)) && !Number.isNaN(Date.parse(w.end)));
  return free.filter((s) =>
    valid.some((w) => Date.parse(w.start) <= Date.parse(s.start) && Date.parse(s.end) <= Date.parse(w.end)),
  );
}

export function isStillFree(slot: Slot, free: Slot[]): boolean {
  return free.some((s) => s.start === slot.start && s.end === slot.end);
}

/** "Tue 7 Oct, 14:00-14:30 BST": how a slot is written in an email. */
export function formatSlot(slot: Slot, timeZone: string): string {
  // Built from parts: en-GB puts a comma after the weekday in some ICU builds.
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).formatToParts(
    new Date(slot.start),
  );
  const part = (t: string) => parts.find((p) => p.type === t)?.value;
  const day = `${part("weekday")} ${part("day")} ${part("month")}`;
  const time = (d: string, zone: boolean) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(zone ? { timeZoneName: "short" } : {}),
    }).format(new Date(d));
  return `${day}, ${time(slot.start, false)}-${time(slot.end, true)}`;
}
