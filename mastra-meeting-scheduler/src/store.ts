/**
 * The little this agent keeps locally, in one JSON file:
 *
 *  - which workflow run owns which SendRaven thread, so an inbound webhook
 *    (which carries a thread_id) can resume the right run;
 *  - every email body the model wrote, keyed by the Idempotency-Key it is
 *    sent with. If the process dies after the send and before Mastra saves the
 *    step, the re-run sends the SAME body under the SAME key, which SendRaven
 *    answers with the stored response instead of a second email (a different
 *    body under a used key would be refused with 422 idempotency_key_reused);
 *  - the bookings, which stand in for writing to a real calendar.
 *
 * Who said what, and whether a person has replied, is never stored here: it
 * is read from the thread on SendRaven each time.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Slot } from "./slots.js";

export interface Booking extends Slot {
  task_id: string;
  with: string;
  topic: string;
  thread_id: string;
}

interface Data {
  runs: Record<string, string>;
  drafts: Record<string, unknown>;
  bookings: Booking[];
}

export class Store {
  private data: Data;

  constructor(private readonly path: string) {
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { runs: {}, drafts: {}, bookings: [] };
  }

  private save() {
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data, null, 2));
    renameSync(`${this.path}.tmp`, this.path);
  }

  linkThread(threadId: string, runId: string) {
    this.data.runs[threadId] = runId;
    this.save();
  }

  /** thread_id to run id, for every negotiation this agent started. */
  threads(): Record<string, string> {
    return { ...this.data.runs };
  }

  runForThread(threadId: string): string | undefined {
    return this.data.runs[threadId];
  }

  /** Write once per key; every later call returns what was written the first time. */
  async draft<T>(key: string, write: () => Promise<T>): Promise<T> {
    if (key in this.data.drafts) return this.data.drafts[key] as T;
    const value = await write();
    this.data.drafts[key] = value;
    this.save();
    return value;
  }

  get bookings(): Booking[] {
    return this.data.bookings;
  }

  /**
   * Holds the slot before the confirmation is sent, the way a person puts a
   * meeting in the calendar before saying "see you then". Idempotent per task.
   * Returns false when another task already holds an overlapping slot.
   */
  reserve(booking: Booking): boolean {
    const mine = this.data.bookings.find((b) => b.task_id === booking.task_id);
    if (mine) return mine.start === booking.start;
    const clash = this.data.bookings.some(
      (b) => Date.parse(b.start) < Date.parse(booking.end) && Date.parse(booking.start) < Date.parse(b.end),
    );
    if (clash) return false;
    this.data.bookings.push(booking);
    this.save();
    return true;
  }

  release(taskId: string) {
    this.data.bookings = this.data.bookings.filter((b) => b.task_id !== taskId);
    this.save();
  }
}
