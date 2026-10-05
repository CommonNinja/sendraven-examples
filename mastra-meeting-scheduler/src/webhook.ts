/**
 * Receiving SendRaven webhooks.
 *
 * Every delivery is a POST with a JSON body and an `X-CN-Signature` header:
 *
 *     X-CN-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
 *
 * keyed with the endpoint's signing secret (the whole string, `whsec_...`
 * included). Verify against the raw bytes you received, before parsing: a
 * re-serialised JSON object will not hash the same.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

export interface InboundEvent {
  type: "inbound";
  /** The received message's id: pass it as reply_to_message_id to answer it. */
  id: string;
  thread_id: string;
  /** From line, lowercased. NOT proof of who sent it: see sender_authenticated. */
  from: string;
  to: string[];
  subject: string;
  /** The reply with quoted history stripped. Untrusted input. */
  text: string;
  received_at: string;
  spam_verdict: string | null;
  spf_verdict: string | null;
  dkim_verdict: string | null;
  dmarc_verdict: string | null;
  sender_authenticated: boolean;
}

export interface EmailEvent {
  type: "send" | "delivery" | "bounce" | "complaint" | "reject" | "open" | "click" | "rendering_failure" | "delivery_delay";
  message_id: string;
  provider_message_id: string | null;
  broadcast_id: string | null;
  variant: string | null;
  to: string[];
  subject: string;
  link: string | null;
  occurred_at: string;
}

export type WebhookEvent = InboundEvent | EmailEvent;

/**
 * Returns true only for a signature made with `secret` over exactly `rawBody`,
 * no older than `toleranceSeconds` (replay protection). Each delivery attempt,
 * retries included, is signed with a fresh timestamp.
 */
export function verifySignature(
  rawBody: string | Buffer,
  header: string | undefined,
  secret: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  const parts = new Map(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1") ?? "";
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > toleranceSeconds) return false;

  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readRaw(req: IncomingMessage, limit = 1_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * A dependency-free webhook receiver. It answers 2xx as soon as the signature
 * checks out and runs `onEvent` afterwards: SendRaven gives a receiver ten
 * seconds, and a slow handler turns into a retry. Deliveries are at-least-once,
 * so `onEvent` must be safe to run twice for the same event.
 */
export function createWebhookServer(secret: string, onEvent: (event: WebhookEvent) => Promise<void> | void): Server {
  return createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let raw: Buffer;
    try {
      raw = await readRaw(req);
    } catch {
      res.writeHead(413).end();
      return;
    }
    const signature = req.headers["x-cn-signature"];
    if (!verifySignature(raw, Array.isArray(signature) ? signature[0] : signature, secret)) {
      res.writeHead(401).end("bad signature");
      return;
    }
    let event: WebhookEvent;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    res.writeHead(204).end();
    try {
      await onEvent(event);
    } catch (e) {
      console.error("webhook handler failed:", e);
    }
  });
}
