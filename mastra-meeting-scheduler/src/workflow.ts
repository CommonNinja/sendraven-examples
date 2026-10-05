/**
 * The scheduling workflow:
 *
 *     invite ──▶ negotiate ⟲ (dountil the negotiation is over)
 *
 * `invite` offers three free slots and sends the first email. `negotiate`
 * suspends until something wakes it (the inbound webhook, or a poll), then
 * re-reads the thread from SendRaven, has the reader classify the reply, and
 * lets `plan()` book, offer other times, close or hand back. Offering other
 * times returns the state unchanged in kind ("waiting"), so the loop runs
 * `negotiate` again and it suspends for the next reply.
 *
 * A suspended run is a row in Mastra's storage, not a sleeping process: a
 * negotiation that takes four days survives restarts and deploys.
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { assemble, type EmailKind, type ReadInput, type WriteInput, type Written } from "./agents.js";
import { plan, threadState, type ReplyIntent } from "./decide.js";
import { replySubject, SendRavenError, type SendRaven, type ThreadDetail } from "./sendraven.js";
import { freeSlots, pickOffer, type Availability, type Slot } from "./slots.js";
import type { Store } from "./store.js";

// ---------------------------------------------------------------- dependencies

/** Everything the steps touch. `main.ts` wires the real ones; the tests wire fakes. */
export interface Deps {
  sr: Pick<SendRaven, "sendEmail" | "getThread">;
  store: Store;
  availability: Availability;
  sender: string;
  maxRounds: number;
  write: (input: WriteInput) => Promise<Written>;
  read: (input: ReadInput) => Promise<ReplyIntent>;
  now: () => Date;
  log: (line: string) => void;
}

let deps: Deps | undefined;
export function configure(d: Deps) {
  deps = d;
}
function d(): Deps {
  if (!deps) throw new Error("configure() the workflow before running it");
  return deps;
}

// ---------------------------------------------------------------- schemas

const SlotSchema = z.object({ start: z.string(), end: z.string() });

export const TaskInput = z.object({
  task_id: z.string(),
  to: z.string(),
  name: z.string().nullable(),
  topic: z.string(),
  duration_minutes: z.number().int().positive(),
});

const Negotiation = TaskInput.extend({
  thread_id: z.string().nullable(),
  subject: z.string(),
  offered: z.array(SlotSchema),
  rounds: z.number().int(),
  our_ids: z.array(z.string()),
  status: z.enum(["waiting", "booked", "declined", "handed_back", "undeliverable"]),
  booked: SlotSchema.nullable(),
  note: z.string().nullable(),
});
export type Negotiation = z.infer<typeof Negotiation>;

// ---------------------------------------------------------------- helpers

function busy(): Slot[] {
  return d().store.bookings;
}

function free(durationMinutes: number): Slot[] {
  return freeSlots(d().availability, busy(), durationMinutes, d().now());
}

/** Write (once per key, see Store.draft) and send. Returns the message id, or null when refused. */
async function writeAndSend(
  n: Negotiation,
  kind: EmailKind,
  key: string,
  slots: Slot[],
  replyTo: string | null,
  transcript?: string,
  beforeSend?: () => Promise<boolean>,
): Promise<{ id: string; threadId: string | null; status: string; subject: string } | null | "superseded"> {
  const { store, sr, sender, availability } = d();
  const written = await store.draft(key, () =>
    d().write({ kind, sender, recipientName: n.name, topic: n.topic, transcript }),
  );
  const subject = replyTo ? replySubject(n.subject) : (written.subject ?? n.topic).slice(0, 120);
  const text = assemble(written, kind, slots, availability.timezone);
  // Writing takes seconds; the person may have written again meanwhile.
  if (beforeSend && !(await beforeSend())) {
    d().log(`[${n.task_id}] a newer reply arrived while writing; starting over`);
    return "superseded";
  }
  try {
    const sent = await sr.sendEmail(
      {
        from: sender,
        to: n.to,
        subject,
        text,
        // Answering a message keeps In-Reply-To and References, so it lands
        // in the same conversation in their mail client and on our thread.
        ...(replyTo ? { reply_to_message_id: replyTo } : {}),
      },
      key,
    );
    if (sent.status === "rejected" || sent.skipped) {
      d().log(`[${n.task_id}] not sent: ${sent.reason}`);
      return null;
    }
    if (sent.status === "pending_approval") d().log(`[${n.task_id}] held for approval (${sent.approval_id})`);
    return { id: sent.id, threadId: sent.thread_id, status: sent.status, subject };
  } catch (e) {
    // A key refused for a reason no retry fixes (allowlist, card, daily cap):
    // stop and say so rather than loop.
    if (e instanceof SendRavenError && (e.needsAPerson || e.type === "daily_limit")) {
      d().log(`[${n.task_id}] refused: ${e.message}`);
      return null;
    }
    throw e;
  }
}

/** The transcript for the writer, with inbound text fenced as untrusted. */
export function renderTranscript(thread: ThreadDetail): string {
  return thread.messages
    .map((m) =>
      m.direction === "outbound"
        ? `[${m.at}] WE SENT:\n${m.text ?? ""}`
        : `[${m.at}] THEY WROTE:\n<untrusted_email>\n${(m.text ?? "").replaceAll("</untrusted_email>", "")}\n</untrusted_email>`,
    )
    .join("\n\n");
}

// ---------------------------------------------------------------- steps

const invite = createStep({
  id: "invite",
  description: "Offer three free slots and send the first email.",
  inputSchema: TaskInput,
  outputSchema: Negotiation,
  execute: async ({ inputData, runId }) => {
    const offered = pickOffer(free(inputData.duration_minutes), 3, [], d().availability.timezone);
    const base: Negotiation = {
      ...inputData,
      thread_id: null,
      subject: inputData.topic,
      offered,
      rounds: 1,
      our_ids: [],
      status: "waiting",
      booked: null,
      note: null,
    };
    if (offered.length === 0) return { ...base, status: "handed_back" as const, note: "no free slot inside the horizon" };

    // One key per task: a crash after the send cannot produce a second invite.
    const sent = await writeAndSend(base, "invite", `invite-${inputData.task_id}`, offered, null);
    if (!sent || sent === "superseded" || !sent.threadId) return { ...base, status: "undeliverable" as const, note: "the invite was not sent" };

    d().store.linkThread(sent.threadId, runId);
    d().log(`[${inputData.task_id}] invite ${sent.status} on thread ${sent.threadId}`);
    return { ...base, thread_id: sent.threadId, subject: sent.subject, our_ids: [sent.id] };
  },
});

const negotiate = createStep({
  id: "negotiate",
  description: "Wait for a reply, read it, and book, offer other times, close or hand back.",
  inputSchema: Negotiation,
  outputSchema: Negotiation,
  resumeSchema: z.object({ reason: z.string() }),
  suspendSchema: z.object({ thread_id: z.string(), waiting_since_round: z.number() }),
  execute: async ({ inputData: n, resumeData, suspend }) => {
    if (n.status !== "waiting" || !n.thread_id) return n;

    // Look before sleeping. A reply that landed while the last pass was
    // working fired its webhook at a run that was not suspended yet, and
    // nothing will fire again; suspending now would sleep on it for good.
    if (!resumeData) {
      const t = threadState(await d().sr.getThread(n.thread_id), n.our_ids);
      if (t.state !== "replied") return await suspend({ thread_id: n.thread_id, waiting_since_round: n.rounds });
    }
    return respond(n, resumeData?.reason ?? "a reply already waiting");
  },
});

/**
 * Read the thread, decide, answer. Never trusts the wake-up itself (a webhook
 * can be a duplicate, a poll can be early): the thread says what happened.
 *
 * The thread is read again just before anything is sent. A person who writes
 * "Wednesday works" and, sixteen seconds later, "actually, none of those"
 * must get an answer to the second message: confirming the first would clear
 * awaiting_reply and bury the correction where nothing ever looks again. So
 * a newer reply throws the draft away and the whole pass starts over with
 * every unanswered message.
 */
async function respond(n: Negotiation, reason: string): Promise<Negotiation> {
  const threadId = n.thread_id!;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const thread = await d().sr.getThread(threadId);
    const t = threadState(thread, n.our_ids);
    d().log(`[${n.task_id}] woken by ${reason}: thread is ${t.state}`);

    if (t.state === "waiting" || t.state === "pending") return n; // the loop suspends again
    if (t.state === "handled") return { ...n, status: "handed_back" as const, note: "someone else answered the thread" };
    if (t.state === "undeliverable") return { ...n, status: "undeliverable" as const, note: "the last email bounced" };

    const intent = await d().read({ replies: t.replies, offered: n.offered, timeZone: d().availability.timezone, now: d().now() });
    d().log(`[${n.task_id}] reader (${t.replies.length} unanswered): ${intent.kind}${intent.option ? ` option ${intent.option}` : ""}. ${intent.note}`);

    const p = plan({
      intent,
      offered: n.offered,
      free: free(n.duration_minutes),
      rounds: n.rounds,
      maxRounds: d().maxRounds,
      timeZone: d().availability.timezone,
    });
    if (p.action === "handback") {
      // Nothing is sent, so the thread stays awaiting_reply and shows up in
      // the dashboard's list of conversations waiting for a person.
      return { ...n, status: "handed_back" as const, note: p.why };
    }

    // One answer per reply: the key names the message it answers, so a crash
    // replays the same email and a newer reply gets a fresh one.
    const key = `answer-${n.task_id}-${t.reply.id}`;
    const stillLatest = async () => {
      const now = threadState(await d().sr.getThread(threadId), n.our_ids);
      return now.state === "replied" && now.reply.id === t.reply.id;
    };
    const transcript = renderTranscript(thread);

    if (p.action === "book") {
      // Hold the slot first, then promise it: a crash in between leaves a
      // hold nobody was told about, never a promise with no hold.
      const held = d().store.reserve({ ...p.slot, task_id: n.task_id, with: n.to, topic: n.topic, thread_id: threadId });
      if (!held) continue; // another negotiation just took it: plan again
      const sent = await writeAndSend(n, "confirm", key, [p.slot], t.reply.id, transcript, stillLatest);
      if (sent === "superseded") {
        d().store.release(n.task_id);
        continue;
      }
      if (!sent) {
        d().store.release(n.task_id);
        return { ...n, status: "handed_back" as const, note: "the confirmation could not be sent; the hold was released" };
      }
      return { ...n, status: "booked" as const, booked: p.slot, our_ids: [...n.our_ids, sent.id], note: intent.note };
    }

    if (p.action === "offer") {
      const kind: EmailKind = p.why === "taken" ? "offer_taken" : "offer_no_fit";
      const sent = await writeAndSend(n, kind, key, p.slots, t.reply.id, transcript, stillLatest);
      if (sent === "superseded") continue;
      if (!sent) return { ...n, status: "handed_back" as const, note: "a new offer could not be sent" };
      return { ...n, offered: p.slots, rounds: n.rounds + 1, our_ids: [...n.our_ids, sent.id], note: intent.note };
    }

    // close
    const sent = await writeAndSend(n, "close", key, [], t.reply.id, transcript, stillLatest);
    if (sent === "superseded") continue;
    return { ...n, status: "declined" as const, our_ids: sent ? [...n.our_ids, sent.id] : n.our_ids, note: intent.note };
  }
  // Replies keep arriving faster than we can answer: let a person read them.
  return { ...n, status: "handed_back" as const, note: "new replies kept arriving while answering" };
}

export const scheduleMeeting = createWorkflow({
  id: "schedule-meeting",
  inputSchema: TaskInput,
  outputSchema: Negotiation,
})
  .then(invite)
  .dountil(negotiate, async ({ inputData }) => inputData.status !== "waiting")
  .commit();
