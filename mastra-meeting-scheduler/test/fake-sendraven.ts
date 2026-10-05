/**
 * An in-memory SendRaven with the behaviour the agent relies on: threads,
 * awaiting_reply set only by a person's reply, reply_to_message_id joining a
 * thread, and Idempotency-Key replays (and 422 on a reused key with a
 * different body).
 */

import { SendRavenError, type SendEmailRequest, type SendEmailResponse, type ThreadDetail } from "../src/sendraven.js";

export class FakeSendRaven {
  threads = new Map<string, ThreadDetail>();
  sends: { key: string; body: SendEmailRequest; res: SendEmailResponse }[] = [];
  /** Set to make the next send come back held for approval. */
  holdNext = false;
  private n = 0;
  private clock = Date.parse("2026-10-05T08:00:00Z");

  private at() {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  async sendEmail(body: SendEmailRequest, key: string): Promise<SendEmailResponse> {
    const prior = this.sends.find((s) => s.key === key);
    if (prior) {
      if (JSON.stringify(prior.body) !== JSON.stringify(body)) {
        throw new SendRavenError(422, "idempotency_key_reused", "key reused with a different body");
      }
      return prior.res;
    }
    const id = `msg_${++this.n}`;
    let thread: ThreadDetail | undefined;
    if (body.reply_to_message_id) {
      thread = [...this.threads.values()].find((t) => t.messages.some((m) => m.id === body.reply_to_message_id));
    }
    if (!thread) {
      thread = {
        id: `thr_${this.n}`,
        subject: body.subject ?? "",
        participants: [String(body.to)],
        message_count: 0,
        awaiting_reply: false,
        pending_reply: false,
        handled_at: null,
        last_message_at: "",
        created_at: this.at(),
        messages: [],
      };
      this.threads.set(thread.id, thread);
    }
    const held = this.holdNext;
    this.holdNext = false;
    thread.messages.push({
      direction: "outbound",
      id,
      from: body.from,
      to: [String(body.to)],
      subject: body.subject ?? "",
      text: body.text ?? null,
      html: null,
      status: held ? "queued" : "delivered",
      at: this.at(),
    });
    if (held) thread.pending_reply = true;
    else thread.awaiting_reply = false;
    const res: SendEmailResponse = {
      id,
      status: held ? "pending_approval" : "sent",
      thread_id: thread.id,
      scheduled_at: null,
      skipped: false,
      reason: null,
      approval_id: held ? "apr_1" : null,
    };
    this.sends.push({ key, body, res });
    return res;
  }

  async getThread(id: string): Promise<ThreadDetail> {
    const t = this.threads.get(id);
    if (!t) throw new SendRavenError(404, "not_found", "No such thread");
    return structuredClone(t);
  }

  /** A person replies: awaiting_reply goes true. */
  reply(threadId: string, text: string, opts: { automated?: boolean; authenticated?: boolean } = {}) {
    const t = this.threads.get(threadId)!;
    const id = `in_${++this.n}`;
    t.messages.push({
      direction: "inbound",
      id,
      from: "ana@example.com",
      to: ["sam@mail.example.com"],
      subject: `Re: ${t.subject}`,
      text,
      raw_text: text,
      html: null,
      sender_authenticated: opts.authenticated ?? true,
      spf_verdict: "PASS",
      dkim_verdict: "PASS",
      dmarc_verdict: "PASS",
      spam_verdict: "PASS",
      virus_verdict: "PASS",
      automated: opts.automated ?? false,
      at: this.at(),
    });
    // An out-of-office is recorded but does not set the flag.
    if (!opts.automated) t.awaiting_reply = true;
    return id;
  }

  /** A colleague answers from another tool. */
  colleagueAnswers(threadId: string) {
    const t = this.threads.get(threadId)!;
    t.messages.push({
      direction: "outbound",
      id: `msg_${++this.n}`,
      from: "lee@mail.example.com",
      to: ["ana@example.com"],
      subject: t.subject,
      text: "I'll take this one.",
      html: null,
      status: "delivered",
      at: this.at(),
    });
    t.awaiting_reply = false;
  }
}
