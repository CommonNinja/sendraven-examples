import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { plan, threadState, type ReplyIntent } from "../src/decide.js";
import type { InboundEntry, OutboundEntry, ThreadDetail } from "../src/sendraven.js";
import { formatSlot, freeSlots, pickOffer, slotsWithin, zonedToUtc, type Availability } from "../src/slots.js";

const av: Availability = {
  timezone: "Europe/London",
  hours: { mon: ["09:30-12:00"], tue: ["09:30-12:00"], wed: ["09:30-12:00"], thu: ["09:30-12:00"], fri: ["09:30-12:00"] },
  min_notice_hours: 12,
  horizon_days: 10,
  step_minutes: 30,
};

describe("slots", () => {
  it("converts wall-clock time on both sides of the October clock change", () => {
    assert.equal(zonedToUtc("2026-10-23", "09:30", "Europe/London").toISOString(), "2026-10-23T08:30:00.000Z"); // BST
    assert.equal(zonedToUtc("2026-10-26", "09:30", "Europe/London").toISOString(), "2026-10-26T09:30:00.000Z"); // GMT
    assert.equal(zonedToUtc("2026-10-06", "09:00", "America/New_York").toISOString(), "2026-10-06T13:00:00.000Z");
  });

  it("respects minimum notice, working hours and weekends", () => {
    const free = freeSlots(av, [], 30, new Date("2026-10-09T20:00:00Z")); // Friday evening
    assert.equal(free[0].start, "2026-10-12T08:30:00.000Z"); // Monday 09:30 BST
    assert.ok(free.every((s) => ![0, 6].includes(new Date(s.start).getUTCDay())));
  });

  it("never offers a slot that overlaps something busy", () => {
    const busy = [{ start: "2026-10-12T08:45:00Z", end: "2026-10-12T09:15:00Z" }];
    const free = freeSlots(av, busy, 30, new Date("2026-10-09T20:00:00Z"));
    assert.equal(free[0].start, "2026-10-12T09:30:00.000Z");
  });

  it("spreads an offer across days", () => {
    const free = freeSlots(av, [], 30, new Date("2026-10-09T20:00:00Z"));
    const offer = pickOffer(free, 3, [], av.timezone);
    assert.deepEqual(
      offer.map((s) => formatSlot(s, av.timezone)),
      ["Mon 12 Oct, 09:30-10:00 BST", "Tue 13 Oct, 09:30-10:00 BST", "Wed 14 Oct, 09:30-10:00 BST"],
    );
  });

  it("keeps only free slots wholly inside the windows they named, and ignores garbage", () => {
    const free = freeSlots(av, [], 30, new Date("2026-10-09T20:00:00Z"));
    const fits = slotsWithin(free, [
      { start: "2026-10-13T10:45:00+01:00", end: "2026-10-13T12:00:00+01:00" },
      { start: "next tuesday", end: "?" },
    ]);
    assert.deepEqual(fits.map((s) => s.start), ["2026-10-13T10:00:00.000Z", "2026-10-13T10:30:00.000Z"]);
  });
});

const intent = (p: Partial<ReplyIntent>): ReplyIntent => ({ kind: "unclear", option: null, windows: [], note: "n", suspicious: false, ...p });
const free = freeSlots(av, [], 30, new Date("2026-10-09T20:00:00Z"));
const offered = pickOffer(free, 3, [], av.timezone);
const base = { offered, free, rounds: 1, maxRounds: 3, timeZone: av.timezone };

describe("plan", () => {
  it("books an accepted option that is still free", () => {
    assert.deepEqual(plan({ ...base, intent: intent({ kind: "accept", option: 3 }) }), { action: "book", slot: offered[2] });
  });

  it("hands back an option number we never offered", () => {
    assert.equal(plan({ ...base, intent: intent({ kind: "accept", option: 7 }) }).action, "handback");
    assert.equal(plan({ ...base, intent: intent({ kind: "accept", option: null }) }).action, "handback");
  });

  it("offers again when the accepted slot was taken meanwhile", () => {
    const p = plan({ ...base, free: free.filter((s) => s.start !== offered[0].start), intent: intent({ kind: "accept", option: 1 }) });
    assert.equal(p.action, "offer");
    assert.equal(p.action === "offer" && p.why, "taken");
  });

  it("hands back once the round limit is reached", () => {
    const p = plan({ ...base, rounds: 3, intent: intent({ kind: "propose", windows: [] }) });
    assert.equal(p.action, "handback");
  });

  it("still books a time they named on the last round", () => {
    const p = plan({ ...base, rounds: 3, intent: intent({ kind: "propose", windows: [{ start: offered[1].start, end: offered[1].end }] }) });
    assert.deepEqual(p, { action: "book", slot: offered[1] });
  });

  it("hands back anything flagged suspicious, even an accept", () => {
    assert.equal(plan({ ...base, intent: intent({ kind: "accept", option: 1, suspicious: true }) }).action, "handback");
  });

  it("closes on a decline and hands back the unclear", () => {
    assert.equal(plan({ ...base, intent: intent({ kind: "decline" }) }).action, "close");
    assert.equal(plan({ ...base, intent: intent({ kind: "unclear" }) }).action, "handback");
  });
});

function thread(p: Partial<ThreadDetail>): ThreadDetail {
  return {
    id: "thr_1",
    subject: "s",
    participants: [],
    message_count: 0,
    awaiting_reply: false,
    pending_reply: false,
    handled_at: null,
    last_message_at: "",
    created_at: "",
    messages: [],
    ...p,
  };
}
const out = (id: string, status = "delivered"): OutboundEntry =>
  ({ direction: "outbound", id, from: "", to: [], subject: "", text: "", html: null, status, at: "" });
const inn = (id: string): InboundEntry =>
  ({
    direction: "inbound", id, from: "", to: [], subject: "", text: "hi", raw_text: "", html: null, sender_authenticated: true,
    spf_verdict: null, dkim_verdict: null, dmarc_verdict: null, spam_verdict: null, virus_verdict: null, at: "",
  });

describe("threadState", () => {
  it("is replied only when SendRaven says a person is awaiting an answer", () => {
    const t = threadState(thread({ awaiting_reply: true, messages: [out("m1"), inn("i1")] }), ["m1"]);
    assert.equal(t.state, "replied");
    assert.equal(t.state === "replied" && t.reply.id, "i1");
    assert.equal(threadState(thread({ messages: [out("m1"), inn("i1")] }), ["m1"]).state, "waiting");
  });

  it("is pending while our answer is held for approval", () => {
    const t = thread({ awaiting_reply: true, pending_reply: true, messages: [out("m1"), inn("i1"), out("m2", "queued")] });
    assert.equal(threadState(t, ["m1", "m2"]).state, "pending");
  });

  it("is handled when someone else wrote on the thread or marked it handled", () => {
    assert.equal(threadState(thread({ messages: [out("m1"), inn("i1"), out("x")] }), ["m1"]).state, "handled");
    assert.equal(threadState(thread({ handled_at: "2026-10-05T00:00:00Z", messages: [out("m1")] }), ["m1"]).state, "handled");
  });

  it("is undeliverable when the last email bounced or nothing went out", () => {
    assert.equal(threadState(thread({ messages: [out("m1", "bounced")] }), ["m1"]).state, "undeliverable");
    assert.equal(threadState(thread({ messages: [out("m1", "failed")] }), ["m1"]).state, "undeliverable");
  });
});
