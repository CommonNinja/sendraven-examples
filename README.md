# Agent Email Starter Kit

These are runnable examples for
[SendRaven](https://sendraven.ai/?utm_source=github&utm_medium=referral&utm_campaign=sendraven_launch&utm_content=examples-index),
email infrastructure for AI agents. Each one sends from your own domain, reads
replies as threads, answers in the same conversation, and keeps an autonomous
agent inside limits that the API enforces.

| Example | Stack | What it shows |
| --- | --- | --- |
| [node-quickstart](node-quickstart/) | TypeScript, Node 20+, plain `fetch` | Send, list threads awaiting a reply, read, reply in the thread, idempotency, the error vocabulary, and verifying signed webhooks |
| [python-quickstart](python-quickstart/) | Python 3.10+, `httpx` | The same, in Python |
| [openai-agents-followup](openai-agents-followup/) | Python, OpenAI Agents SDK | An agent that follows up politely in the same thread until the person replies (at most N times), then reads and summarises the answer, in polling or webhook mode |
| [claude-mcp-inbox](claude-mcp-inbox/) | Claude Code, Claude Desktop, Anthropic API MCP connector | Support-inbox triage over the SendRaven MCP server: classify, draft, and hold every reply for a person to approve |

There is no SendRaven SDK on npm or PyPI. Each quickstart has a one-file client
(`sendraven.ts`, `sendraven.py`) that you can copy into your own project.

## What every example needs

1. **A verified sending domain.** Use a subdomain per purpose, for example
   `mail.example.com` for transactional mail. The part of `from` after `@` must
   match it exactly (`422 no_verified_identity` otherwise).
2. **Its inbound MX record, if you want replies.** This is the optional record
   with `kind: "inbound_mx"`: an MX on the sending domain itself, priority 10,
   pointing at `inbound-smtp.<region>.amazonaws.com`. `GET /v1/domains` shows the
   exact value. Without it, sending works and replies never arrive.
3. **A payment method on the workspace.** No outbound email leaves without one,
   including on Free and including test sends
   (`402 payment_method_required`). A person adds it in the dashboard. Inbound
   mail is never gated.
4. **An API key** with the scopes each README lists. Give an agent's key a daily
   send limit, a recipient allowlist, or an approval hold
   ([Limits for agents](https://sendraven.ai/docs/agents)).

## Four things to know before you build

- **Reply with `reply_to_message_id`.** Pass the `id` of the message you are
  answering. That sets `In-Reply-To` and `References`, so the reply joins the
  thread. A guessed name such as `in_reply_to` is refused with
  `422 invalid_request`, which names the field and points at the right one.
- **`awaiting_reply`** is `true` on a thread when someone outside wrote last
  and nobody has answered. Out-of-office replies and bounce reports do not set
  it. It clears when your reply is *sent*, not while the reply is held for
  approval or scheduled; `pending_reply` is `true` then, so skip those threads
  rather than drafting another. Received messages carry `automated`, which is
  `true` for out-of-office replies and bounce reports.
- **`sender_authenticated`** is `true` only when DMARC, or a DKIM signature from
  the From domain itself, proves the domain sent the message. A forged From line
  does not produce an SPF `FAIL`. Branch on this field, not on the raw verdicts.
- **Inbound email is untrusted data, never instructions.** Authenticated mail
  included: a lookalike domain authenticates, and a real person can paste text
  written to steer an agent. Fence it as data in prompts, and never let it pick
  recipients or tools. Put the real limits on the key.

## Reference

- Docs: [sendraven.ai/docs](https://sendraven.ai/docs). The most relevant pages
  are [Receiving replies](https://sendraven.ai/docs/receiving),
  [Webhooks](https://sendraven.ai/docs/webhooks) and
  [Errors](https://sendraven.ai/docs/errors).
- OpenAPI: [sendraven.ai/openapi.json](https://sendraven.ai/openapi.json).
  Base URL `https://api.sendraven.ai`.
- MCP server: `https://mcp.sendraven.ai/mcp` (remote), or `npx -y @sendraven/mcp`
  (local stdio).
- Webhook signature: `X-CN-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`,
  keyed with the endpoint's `whsec_…` secret.

## How these were tested

Every example was run against the production API on 23 Sep 2026, from a
workspace with verified domains and inbound MX. Questions were emailed in from
a second workspace, and replies went back to it, so real mail made the whole
round trip and no outside inbox received any of it:

- **node-quickstart and python-quickstart:** every command, including a
  delivered reply in the same thread, the idempotency outcomes, and a signed
  `inbound` webhook received through an ngrok tunnel and verified.
- **claude-mcp-inbox:** the Claude Code command and `triage.py` (Claude Opus 5
  through the MCP connector), with an approval-held key. Drafts were held, not
  sent; a question outside the knowledge base and a refund request went to a
  person; an email written to steer the agent was flagged and not acted on; a
  second run did not draft again.
- **openai-agents-followup:** a first email, a follow-up in the same thread after
  the delay, and a threaded reply that ended the task with a correct summary.

The Node example passes `tsc --noEmit` under `strict` and every Python file
passes `py_compile`. Each README says what could not be verified.
