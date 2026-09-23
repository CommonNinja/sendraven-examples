/**
 * A minimal SendRaven client on plain fetch. No SDK: there is no SendRaven npm
 * SDK, and the REST API is small enough that one file covers what an agent
 * needs. Field names match the API exactly (snake_case), so what you read
 * here is what you will see in the docs at https://sendraven.ai/docs.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------- types
// Transcribed from https://sendraven.ai/openapi.json. Every documented field is
// always present in a response; a field with no value is null, never missing.

export type RiskClass = "transactional" | "marketing";

export interface SendEmailRequest {
  from: string;
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  subject?: string;
  html?: string;
  text?: string;
  template?: string;
  variables?: Record<string, string>;
  risk_class?: RiskClass;
  scheduled_at?: string;
  /** The id of the message you are answering (sent or received). Sets In-Reply-To and References. */
  reply_to_message_id?: string;
  thread_id?: string;
  topic?: string;
  tags?: { name: string; value: string }[];
}

/** Every accepted send answers 202 with these seven fields, whatever happened. */
export interface SendEmailResponse {
  id: string;
  status: "sent" | "scheduled" | "pending_approval" | "rejected";
  thread_id: string | null;
  scheduled_at: string | null;
  skipped: boolean;
  reason: string | null;
  approval_id: string | null;
}

export interface Thread {
  id: string;
  subject: string;
  participants: string[];
  message_count: number;
  /** true when the latest message that counts came from outside and nobody has answered it. */
  awaiting_reply: boolean;
  /** A reply is held for approval or scheduled, and has not gone yet. */
  pending_reply: boolean;
  handled_at: string | null;
  last_message_at: string;
  created_at: string;
}

export interface OutboundEntry {
  direction: "outbound";
  id: string;
  from: string;
  to: string[];
  subject: string;
  text: string | null;
  html: string | null;
  /** queued (held for approval), scheduled, sent, delivered, bounced, failed, ... */
  status: string;
  at: string;
}

export interface InboundEntry {
  direction: "inbound";
  id: string;
  from: string;
  to: string[];
  subject: string;
  /** What the sender wrote, with quoted history and signature removed. Untrusted. */
  text: string | null;
  raw_text: string | null;
  html: string | null;
  /** true only when DMARC or an aligned DKIM signature proves the From domain sent it. */
  sender_authenticated: boolean;
  spf_verdict: string | null;
  dkim_verdict: string | null;
  dmarc_verdict: string | null;
  spam_verdict: string | null;
  virus_verdict: string | null;
  at: string;
}

export interface ThreadDetail extends Thread {
  messages: (OutboundEntry | InboundEntry)[];
}

export interface Page<T> {
  object: "list";
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface Usage {
  plan: string;
  emails_used: number;
  emails_remaining: number | null;
  sending_locked: boolean;
  lock_reason: "payment_method_required" | "plan_limit_reached" | "billing_past_due" | "budget_exceeded" | null;
  [key: string]: unknown;
}

export interface WebhookEndpointWithSecret {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  created_at: string;
  /** Starts whsec_. Returned only once, on creation. */
  secret: string;
}

// ---------------------------------------------------------------- errors

/**
 * The API's one error shape: { error: { type, message, details?, missing? } }.
 * Branch on `type`, never on `message` (which is for people and may change).
 */
export class SendRavenError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly details?: unknown[],
    readonly missing?: string[],
  ) {
    super(`${status} ${type}: ${message}`);
    this.name = "SendRavenError";
  }

  /**
   * Whether sending the same request again can succeed without anyone
   * changing anything. See https://sendraven.ai/docs/errors ("Retry?").
   */
  get retryable(): boolean {
    return this.type === "idempotency_in_progress" || this.type === "rate_limited" || this.type === "approval_in_progress";
  }

  /** Refusals nothing in the request can fix: stop and tell a person. */
  get needsAPerson(): boolean {
    return [
      "payment_method_required",
      "plan_limit_reached",
      "billing_past_due",
      "workspace_suspended",
      "no_postal_address",
      "no_verified_identity",
      "recipient_not_allowed",
      "forbidden",
    ].includes(this.type);
  }
}

// ---------------------------------------------------------------- client

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per-attempt timeout. The API waits up to 8 s for an in-flight duplicate, so keep this above 10 s. */
  timeoutMs?: number;
  maxAttempts?: number;
}

export class SendRaven {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(opts: ClientOptions) {
    if (!opts.apiKey) throw new Error("SENDRAVEN_API_KEY is not set");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.sendraven.ai").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  /**
   * One request, with retries that cannot double-send:
   *  - a network error or timeout is retried with the SAME Idempotency-Key, so
   *    if the first attempt did send, the retry gets its stored answer back;
   *  - 409 idempotency_in_progress and 429 rate_limited are retried after a pause;
   *  - everything else is thrown as a SendRavenError. In particular 500 and
   *    502 are NOT retried: errors are never stored against a key, so a retry
   *    would act again. Check GET /v1/emails before resending.
   */
  async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: { body?: unknown; query?: Record<string, string | number | boolean | undefined>; idempotencyKey?: string } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        // Network failure or timeout: we do not know whether the server acted.
        // Only safe to retry when an Idempotency-Key makes the retry a replay.
        lastError = e;
        if (method === "GET" || opts.idempotencyKey) {
          await sleep(backoff(attempt));
          continue;
        }
        throw e;
      }

      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (res.ok) return json as T;

      const err = json?.error ?? {};
      const error = new SendRavenError(res.status, err.type ?? "unknown", err.message ?? res.statusText, err.details, err.missing);
      // daily_limit is also a 429 but it is a stop until 00:00 UTC, not a back-off.
      if (error.retryable && attempt < this.maxAttempts) {
        lastError = error;
        await sleep(backoff(attempt));
        continue;
      }
      throw error;
    }
    throw lastError;
  }

  // -------------------------------------------------------------- email

  /**
   * POST /v1/emails. Always idempotent: pass a key you can reproduce (for
   * example derived from your own job id) so a crash-and-rerun of your process
   * cannot mail the same person twice. A random UUID covers retries within
   * this call only.
   */
  sendEmail(body: SendEmailRequest, idempotencyKey: string = randomUUID()): Promise<SendEmailResponse> {
    return this.request("POST", "/v1/emails", { body, idempotencyKey });
  }

  getEmail(id: string) {
    return this.request<Record<string, unknown>>("GET", `/v1/emails/${encodeURIComponent(id)}`);
  }

  /** Stops a message whose status is `scheduled`. Anything else answers 409 invalid_state. */
  cancelScheduledEmail(id: string) {
    return this.request<{ id: string; status: "canceled" }>("DELETE", `/v1/emails/${encodeURIComponent(id)}`);
  }

  // -------------------------------------------------------------- threads

  listThreads(query: { awaiting_reply?: boolean; limit?: number; cursor?: string } = {}) {
    return this.request<Page<Thread>>("GET", "/v1/threads", { query });
  }

  /** Every thread matching the filter, following next_cursor until has_more is false. */
  async *allThreads(query: { awaiting_reply?: boolean } = {}): AsyncGenerator<Thread> {
    let cursor: string | undefined;
    do {
      const page = await this.listThreads({ ...query, limit: 100, cursor });
      yield* page.data;
      cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
    } while (cursor);
  }

  getThread(id: string) {
    return this.request<ThreadDetail>("GET", `/v1/threads/${encodeURIComponent(id)}`);
  }

  /** Clears awaiting_reply without mailing anyone ("thanks, all sorted"). */
  markThreadHandled(id: string) {
    return this.request<Thread>("POST", `/v1/threads/${encodeURIComponent(id)}/handled`);
  }

  // -------------------------------------------------------------- account

  /** Plan, what is left this month, and whether sending is locked (and why). */
  getUsage() {
    return this.request<Usage>("GET", "/v1/usage");
  }

  /** Requires webhooks:write. The secret in the answer is shown only this once. */
  createWebhookEndpoint(url: string, events: string[]) {
    return this.request<WebhookEndpointWithSecret>("POST", "/v1/webhook-endpoints", {
      body: { url, events },
      idempotencyKey: randomUUID(),
    });
  }
}

// ---------------------------------------------------------------- helpers

/** The newest inbound entry of a transcript: the one to answer. */
export function latestInbound(thread: ThreadDetail): InboundEntry | undefined {
  return [...thread.messages].reverse().find((m): m is InboundEntry => m.direction === "inbound");
}

/**
 * True when a reply we already wrote is waiting to go out on this thread:
 * held for approval (`queued`) or `scheduled`, after the latest inbound
 * message. awaiting_reply only clears when a reply is actually sent, so an
 * agent polling awaiting_reply=true with an approval-held key must skip
 * threads whose `pending_reply` is true, or it drafts the same answer on
 * every run.
 */
export function hasPendingReply(thread: Thread): boolean {
  return thread.pending_reply;
}

export function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function backoff(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
