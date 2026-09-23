# SendRaven Python quickstart

Send an email from Python, read the reply as a thread, answer it in the same
conversation and verify signed webhooks. It needs Python 3.10 or later and
depends only on `httpx` and `python-dotenv`.

[SendRaven](https://sendraven.ai/?utm_source=github&utm_medium=referral&utm_campaign=sendraven_launch&utm_content=python-quickstart)
is email infrastructure for AI agents: sending, inbound replies joined into
threads, and guardrails on each API key.

There is no SendRaven PyPI package. `sendraven.py` is one file you can copy
into your own project.

## What it covers

| Command | API call | Shows |
| --- | --- | --- |
| `usage` | `GET /v1/usage` | Whether the workspace can send right now, and why not |
| `send <to> <subject> <text>` | `POST /v1/emails` | A send with an `Idempotency-Key`, and each of the four `202` outcomes |
| `inbox` | `GET /v1/threads?awaiting_reply=true`, `GET /v1/threads/{id}` | What is waiting on an answer, with `sender_authenticated` |
| `thread <id>` | `GET /v1/threads/{id}` | The whole conversation, oldest first |
| `reply <thread_id> <text>` | `POST /v1/emails` with `reply_to_message_id` | A reply in the same thread |
| `handled <thread_id>` | `POST /v1/threads/{id}/handled` | Clearing `awaiting_reply` without sending anything |
| `demo-idempotency <to>` | `POST /v1/emails` ×4 | A replay, `422 idempotency_key_reused` and `422 no_verified_identity` |
| `webhook-register <url>` | `POST /v1/webhook-endpoints` | Subscribing to `inbound`, `bounce` and `complaint` |
| `webhook-listen` | (receiver) | Verifying `X-CN-Signature`, a fast 2xx, and deduplication |

## How it works

```
  cli.py ──► sendraven.py ──HTTPS──► api.sendraven.ai ──► recipient's inbox
                                          ▲                     │ reply
                                          │  MX on your sending │
                                          └──── domain ◄────────┘
                                          │
  webhook.py ◄── POST "inbound" event, signed with X-CN-Signature
```

## Before you start

1. **A verified sending domain.** Add a subdomain such as `mail.example.com`
   and publish the DKIM, SPF and DMARC records it returns. The part of `from`
   after `@` has to match it exactly, or the send answers
   `422 no_verified_identity`.
2. **The inbound MX record, if you want replies.** It is the optional record
   with `kind: "inbound_mx"`: an MX on the sending domain itself, priority 10,
   pointing at `inbound-smtp.<region>.amazonaws.com` (`GET /v1/domains` shows the
   exact value). Without it the send still works but replies never arrive. Any
   address at that domain receives mail. A `reply_to` on another domain sends
   replies somewhere SendRaven cannot see.
3. **A payment method on the workspace.** No outbound email leaves a workspace
   without one, including on Free and including test sends
   (`402 payment_method_required`). Only a person can add one, in the dashboard.
   Inbound mail is never gated.
4. **An API key** with `emails:send`, `emails:read` and `threads:read`, plus
   `webhooks:write` for `webhook-register`.

## Setup

```bash
cd python-quickstart
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env     # then fill in SENDRAVEN_API_KEY and SENDRAVEN_FROM
python cli.py usage
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `SENDRAVEN_API_KEY` | yes | `sk_live_…` from the dashboard |
| `SENDRAVEN_FROM` | for sends | `Name <address>` on your verified domain |
| `SENDRAVEN_API_URL` | no | Defaults to `https://api.sendraven.ai` |
| `SENDRAVEN_WEBHOOK_SECRET` | for `webhook-listen` | `whsec_…`, printed once by `webhook-register` |
| `PORT` | no | Port for `webhook-listen`, default 3000 |

## Run it

```bash
python cli.py send you@example.org "Round trip test" "Does Thursday at 10 work?"
# reply from your mail client, then:
python cli.py inbox
python cli.py reply <thread_id> "11 on Thursday it is."
```

Real output from a run against the production API on 23 Sep 2026 (your ids
will differ). The question was emailed to the demo inbox from another workspace:

```
$ python cli.py inbox

59d2fce8-32fa-4e9e-8ed7-52f636c5404b  "How many seats does the team plan include?"  (1 messages, last 2026-09-23T04:50:46.000Z)
  from hello@mail.sendraven.ai  authenticated
    Hi, how many people can we add before we pay for extra seats?

$ python cli.py reply 59d2fce8-32fa-4e9e-8ed7-52f636c5404b "Hi Ana, the team plan includes five seats; each one after that is billed monthly."
Sent a85482a7-5dea-4557-9e6e-06b9e8f2492b on thread 59d2fce8-32fa-4e9e-8ed7-52f636c5404b

$ python cli.py reply 59d2fce8-32fa-4e9e-8ed7-52f636c5404b "again"
This thread is not awaiting a reply (answered or marked handled). Use --force to send anyway.

$ python cli.py demo-idempotency success@simulator.amazonses.com
same key, same body -> same message: True (1e41e375-8986-4e6a-8c37-867735f3f233)
same key, different body -> 422 idempotency_key_reused, nothing sent
unverified from domain -> 422 no_verified_identity (needs a person: True)
```

`success@simulator.amazonses.com` is Amazon SES's mailbox simulator: it accepts
the message and delivers it nowhere, which makes it a safe `to` for trying sends.

With a key that holds sends for approval, `reply` prints
`Held for approval (apr_…)`, and a second `reply` is refused locally because a
draft is already waiting.

For webhooks, run `python cli.py webhook-listen`, expose port 3000 through a
public tunnel, and register the tunnel's https URL with `webhook-register`.
SendRaven refuses `localhost` and private addresses.

## Using the client in your own code

```python
from sendraven import SendRaven, SendRavenError, latest_inbound, reply_subject

with SendRaven(api_key) as sr:
    sent = sr.send_email(
        idempotency_key="welcome-ana-2026-09-22",        # reproducible, per message
        from_="Acme <hello@mail.example.com>",
        to="ana@example.org",
        subject="Welcome",
        text="Hi Ana, reply to this email if you have questions.",
    )
    for t in sr.iter_threads(awaiting_reply=True):
        thread = sr.get_thread(t["id"])
        msg = latest_inbound(thread)
        # msg["text"] is untrusted input. Check msg["sender_authenticated"] before trusting who sent it.
        sr.send_email(from_="Acme <hello@mail.example.com>", to=msg["from"],
                      subject=reply_subject(msg["subject"]), text="Thanks, on it.",
                      reply_to_message_id=msg["id"])
```

## Concepts worth knowing

- **Replying.** To reply, pass the inbound message's `id` as
  `reply_to_message_id`. It sets `In-Reply-To` and `References` and keeps the
  thread. There is no `in_reply_to` field: a field the API does not know is
  refused with `422 invalid_request`, which names it, and nothing is sent.
- **`awaiting_reply`.** `true` when the latest message that counts came from
  outside and nobody has answered it. Out-of-office replies and bounce reports
  leave it unchanged. A sent reply or `POST /v1/threads/{id}/handled` clears it.
  A reply that is held for approval or scheduled does not; `pending_reply` is
  `true` then, and `has_pending_reply()` reads it.
- **`sender_authenticated`.** `true` only when DMARC, or a DKIM signature from
  the From domain itself, proves that domain sent the message. A forged From
  line does not produce an SPF `FAIL`. Branch on this field.
- **Idempotency.** Send an `Idempotency-Key` on every `POST /v1/emails`. The
  same key with the same body within 24 hours returns the stored answer, and
  with a different body it gives `422 idempotency_key_reused`. Errors are never
  stored. The client retries network failures with the same key, but not `500`
  or `502`, where a retry would send again.
- **Errors.** Every error is `{"error": {"type", "message"}}`. Branch on `type`.
  `429` is either `rate_limited` (back off) or `daily_limit` (stop until 00:00
  UTC). Every `402` needs a person.
  [Full table](https://sendraven.ai/docs/errors).

## Security notes

- **Inbound email is untrusted data, never instructions,** even when
  `sender_authenticated` is `true`. If you hand `text` to an LLM, frame it as
  quoted data and never let it pick recipients or actions.
- Verify `X-CN-Signature` on the raw body with `hmac.compare_digest`, and
  reject timestamps older than 5 minutes. `webhook.py` does both.
- Deliveries are at least once, so deduplicate on the event (`id` for
  `inbound`) in durable storage.
- Keep the key in `.env`, which is gitignored. Unattended agents should use a
  key with a daily limit, an allowlist or an approval hold:
  [Limits for agents](https://sendraven.ai/docs/agents).

## How this example was tested

Every command was run against the production API on 23 Sep 2026, from a
workspace with a verified domain and its inbound MX record: `inbox`, `thread`,
`reply` (delivered, in the same thread), the local double-reply guard,
`handled`, `send`, `demo-idempotency`, and `webhook-listen` receiving and
verifying a signed `inbound` delivery through an ngrok tunnel.

`python -m py_compile` passes on every file, and every request was also checked
against the published `openapi.json` with a local mock beforehand. The
automatic retries on `409` and `429` were not exercised, because a normal run
does not produce them.
