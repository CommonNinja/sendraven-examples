/**
 * SendRaven Node quickstart: send, read replies, answer in the same thread,
 * receive webhooks. Run `npm run dev -- help` for the commands.
 */

import { randomUUID } from "node:crypto";
import { SendRaven, SendRavenError, hasPendingReply, latestInbound, replySubject } from "./sendraven.js";
import { createWebhookServer } from "./webhook.js";

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
};

const client = () =>
  new SendRaven({ apiKey: env("SENDRAVEN_API_KEY"), baseUrl: process.env.SENDRAVEN_API_URL || undefined });

const commands: Record<string, (args: string[]) => Promise<void>> = {
  /** GET /v1/usage: can this workspace send right now? */
  async usage() {
    const u = await client().getUsage();
    console.log(`plan=${u.plan} used=${u.emails_used} remaining=${u.emails_remaining ?? "unlimited"}`);
    if (u.sending_locked) console.log(`Sending is locked: ${u.lock_reason}. A person has to fix this in the dashboard.`);
  },

  /** POST /v1/emails */
  async send([to, subject, ...words]) {
    if (!to || !subject || words.length === 0) throw new Usage("send <to> <subject> <text...>");
    const sent = await client().sendEmail({ from: env("SENDRAVEN_FROM"), to, subject, text: words.join(" ") });
    report(sent);
  },

  /** GET /v1/threads?awaiting_reply=true, then the latest reply in each. */
  async inbox() {
    const sr = client();
    let n = 0;
    for await (const t of sr.allThreads({ awaiting_reply: true })) {
      n++;
      const detail = await sr.getThread(t.id);
      const reply = latestInbound(detail);
      console.log(`\n${t.id}  "${t.subject}"  (${t.message_count} messages, last ${t.last_message_at})`);
      if (hasPendingReply(detail)) console.log("  a reply is already drafted (held for approval or scheduled)");
      if (reply) {
        console.log(`  from ${reply.from}  ${reply.sender_authenticated ? "authenticated" : "NOT authenticated: the From line may be forged"}`);
        console.log(indent(reply.text ?? "(no text)"));
      }
    }
    if (n === 0) console.log("Nothing is waiting on a reply.");
  },

  /** GET /v1/threads/{id}: the whole conversation, oldest first. */
  async thread([id]) {
    if (!id) throw new Usage("thread <thread_id>");
    const t = await client().getThread(id);
    console.log(`${t.subject}  awaiting_reply=${t.awaiting_reply}`);
    for (const m of t.messages) {
      const who = m.direction === "inbound" ? `<- ${m.from}${m.sender_authenticated ? "" : " (unauthenticated)"}` : `-> ${m.to.join(", ")} [${m.status}]`;
      console.log(`\n${m.at}  ${who}\n${indent(m.text ?? "")}`);
    }
  },

  /**
   * Answer the latest inbound message of a thread. reply_to_message_id sets
   * In-Reply-To and References, so the recipient's client shows one
   * conversation, and the thread's awaiting_reply clears once it is sent.
   */
  async reply([threadId, ...words]) {
    if (!threadId || words.length === 0) throw new Usage("reply <thread_id> <text...>");
    const sr = client();
    const thread = await sr.getThread(threadId);
    const inbound = latestInbound(thread);
    if (!inbound) throw new Error("That thread has no inbound message to answer.");
    if (hasPendingReply(thread)) throw new Error("A reply is already waiting to go out on this thread.");
    if (!thread.awaiting_reply && !process.env.FORCE) {
      throw new Error("This thread is not awaiting a reply (it was answered or marked handled). Set FORCE=1 to send anyway.");
    }

    const sent = await sr.sendEmail(
      {
        from: env("SENDRAVEN_FROM"),
        to: inbound.from,
        subject: replySubject(inbound.subject),
        text: words.join(" "),
        reply_to_message_id: inbound.id,
      },
      // Reproducible key: re-running this exact command for this exact
      // inbound message replays the first answer instead of sending again.
      `reply-${inbound.id}-${hash(words.join(" "))}`,
    );
    report(sent);
  },

  /** POST /v1/threads/{id}/handled: clear awaiting_reply without mailing anyone. */
  async handled([threadId]) {
    if (!threadId) throw new Usage("handled <thread_id>");
    const t = await client().markThreadHandled(threadId);
    console.log(`${t.id} awaiting_reply=${t.awaiting_reply} handled_at=${t.handled_at}`);
  },

  /** Idempotency and the error vocabulary, shown on real calls. */
  async "demo-idempotency"([to]) {
    if (!to) throw new Usage("demo-idempotency <to>");
    const sr = client();
    const key = randomUUID();
    const body = { from: env("SENDRAVEN_FROM"), to, subject: "Idempotency demo", text: "Sent once, however often it is retried." };
    const first = await sr.sendEmail(body, key);
    const again = await sr.sendEmail(body, key);
    console.log(`same key, same body -> same message: ${first.id === again.id} (${first.id})`);
    try {
      await sr.sendEmail({ ...body, text: "A different message." }, key);
    } catch (e) {
      if (e instanceof SendRavenError && e.type === "idempotency_key_reused") console.log("same key, different body -> 422 idempotency_key_reused, nothing sent");
      else throw e;
    }
    try {
      await sr.sendEmail({ ...body, from: "someone@unverified.example" }, randomUUID());
    } catch (e) {
      if (e instanceof SendRavenError) console.log(`unverified from domain -> ${e.status} ${e.type} (needs a person: ${e.needsAPerson})`);
      else throw e;
    }
  },

  /** POST /v1/webhook-endpoints for the inbound event. Needs webhooks:write. */
  async "webhook-register"([url]) {
    if (!url) throw new Usage("webhook-register <public https url>");
    const ep = await client().createWebhookEndpoint(url, ["inbound", "bounce", "complaint"]);
    console.log(`Registered ${ep.id} for ${ep.events.join(", ")}.`);
    console.log(`Put this in .env as SENDRAVEN_WEBHOOK_SECRET; it is not shown again:\n${ep.secret}`);
  },

  /** A local receiver. Expose it through a public tunnel; SendRaven will not deliver to localhost. */
  async "webhook-listen"() {
    const secret = env("SENDRAVEN_WEBHOOK_SECRET");
    const port = Number(process.env.PORT || 3000);
    const seen = new Set<string>(); // at-least-once delivery: dedupe (use a database in production)
    createWebhookServer(secret, (event) => {
      if (event.type !== "inbound") {
        console.log(`${event.type} for message ${event.message_id} (${event.to.join(", ")})`);
        return;
      }
      if (seen.has(event.id)) return;
      seen.add(event.id);
      console.log(`\nReply on thread ${event.thread_id} from ${event.from} (${event.sender_authenticated ? "authenticated" : "UNAUTHENTICATED"})`);
      console.log(indent(event.text));
      console.log(`Answer it with: npm run dev -- reply ${event.thread_id} "..."`);
    }).listen(port, () => console.log(`Listening for signed webhooks on :${port}`));
  },
};

class Usage extends Error {}

function report(sent: Awaited<ReturnType<SendRaven["sendEmail"]>>) {
  switch (sent.status) {
    case "sent":
      console.log(`Sent ${sent.id} on thread ${sent.thread_id}`);
      break;
    case "scheduled":
      console.log(`Scheduled ${sent.id} for ${sent.scheduled_at}`);
      break;
    case "pending_approval":
      // Not an error, and nothing to retry: retrying drafts a second copy.
      console.log(`Held for approval (${sent.approval_id}). A person releases it in the dashboard.`);
      break;
    case "rejected":
      // Every `to` address was suppressed or opted out. Also not an error.
      console.log(`Not sent: ${sent.reason}`);
      break;
  }
}

function indent(s: string) {
  return s
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

function hash(s: string) {
  let h = 0;
  for (const c of s) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

async function main() {
  const [name, ...args] = process.argv.slice(2);
  const cmd = name ? commands[name] : undefined;
  if (!cmd) {
    console.log(`Commands: ${Object.keys(commands).join(", ")}`);
    return;
  }
  try {
    await cmd(args);
  } catch (e) {
    if (e instanceof Usage) {
      console.error(`Usage: npm run dev -- ${e.message}`);
    } else if (e instanceof SendRavenError) {
      console.error(e.message);
      if (e.details) console.error(JSON.stringify(e.details, null, 2));
      if (e.missing) console.error(`missing variables: ${e.missing.join(", ")}`);
      if (e.needsAPerson) console.error("Retrying will not help; a person has to act (see https://sendraven.ai/docs/errors).");
    } else {
      console.error(e instanceof Error ? e.message : e);
    }
    process.exitCode = 1;
  }
}

main();
