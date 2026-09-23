"""
SendRaven Python quickstart: send, read replies, answer in the same thread,
receive webhooks.   python cli.py --help
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import textwrap
import uuid

from dotenv import load_dotenv

from sendraven import SendRaven, SendRavenError, has_pending_reply, latest_inbound, reply_subject
import webhook


def env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.exit(f"Missing {name}. Copy .env.example to .env and fill it in.")
    return value


def client() -> SendRaven:
    return SendRaven(env("SENDRAVEN_API_KEY"), os.environ.get("SENDRAVEN_API_URL") or None)


def indent(s: str | None) -> str:
    return textwrap.indent(s or "", "    ")


def report(sent: dict) -> None:
    status = sent["status"]
    if status == "sent":
        print(f"Sent {sent['id']} on thread {sent['thread_id']}")
    elif status == "scheduled":
        print(f"Scheduled {sent['id']} for {sent['scheduled_at']}")
    elif status == "pending_approval":
        # Not an error, and nothing to retry: retrying drafts a second copy.
        print(f"Held for approval ({sent['approval_id']}). A person releases it in the dashboard.")
    elif status == "rejected":
        # Every `to` address was suppressed or opted out. Also not an error.
        print(f"Not sent: {sent['reason']}")


# ---------------------------------------------------------------- commands

def cmd_usage(_: argparse.Namespace) -> None:
    with client() as sr:
        u = sr.get_usage()
    remaining = "unlimited" if u["emails_remaining"] is None else u["emails_remaining"]
    print(f"plan={u['plan']} used={u['emails_used']} remaining={remaining}")
    if u["sending_locked"]:
        print(f"Sending is locked: {u['lock_reason']}. A person has to fix this in the dashboard.")


def cmd_send(a: argparse.Namespace) -> None:
    with client() as sr:
        report(sr.send_email(from_=env("SENDRAVEN_FROM"), to=a.to, subject=a.subject, text=a.text))


def cmd_inbox(_: argparse.Namespace) -> None:
    n = 0
    with client() as sr:
        for t in sr.iter_threads(awaiting_reply=True):
            n += 1
            detail = sr.get_thread(t["id"])
            reply = latest_inbound(detail)
            print(f"\n{t['id']}  \"{t['subject']}\"  ({t['message_count']} messages, last {t['last_message_at']})")
            if has_pending_reply(detail):
                print("  a reply is already drafted (held for approval or scheduled)")
            if reply:
                auth = "authenticated" if reply["sender_authenticated"] else "NOT authenticated: the From line may be forged"
                print(f"  from {reply['from']}  {auth}")
                print(indent(reply["text"] or "(no text)"))
    if n == 0:
        print("Nothing is waiting on a reply.")


def cmd_thread(a: argparse.Namespace) -> None:
    with client() as sr:
        t = sr.get_thread(a.thread_id)
    print(f"{t['subject']}  awaiting_reply={str(t['awaiting_reply']).lower()}")
    for m in t["messages"]:
        if m["direction"] == "inbound":
            who = f"<- {m['from']}" + ("" if m["sender_authenticated"] else " (unauthenticated)")
        else:
            who = f"-> {', '.join(m['to'])} [{m['status']}]"
        print(f"\n{m['at']}  {who}\n{indent(m['text'])}")


def cmd_reply(a: argparse.Namespace) -> None:
    """reply_to_message_id sets In-Reply-To and References, so the recipient's
    client shows one conversation; awaiting_reply clears once it is sent."""
    with client() as sr:
        thread = sr.get_thread(a.thread_id)
        inbound = latest_inbound(thread)
        if not inbound:
            sys.exit("That thread has no inbound message to answer.")
        if has_pending_reply(thread):
            sys.exit("A reply is already waiting to go out on this thread.")
        if not thread["awaiting_reply"] and not a.force:
            sys.exit("This thread is not awaiting a reply (answered or marked handled). Use --force to send anyway.")
        digest = hashlib.sha256(a.text.encode()).hexdigest()[:12]
        report(sr.send_email(
            # Reproducible key: re-running this exact reply replays the first answer.
            idempotency_key=f"reply-{inbound['id']}-{digest}",
            from_=env("SENDRAVEN_FROM"),
            to=inbound["from"],
            subject=reply_subject(inbound["subject"]),
            text=a.text,
            reply_to_message_id=inbound["id"],
        ))


def cmd_handled(a: argparse.Namespace) -> None:
    with client() as sr:
        t = sr.mark_thread_handled(a.thread_id)
    print(f"{t['id']} awaiting_reply={str(t['awaiting_reply']).lower()} handled_at={t['handled_at']}")


def cmd_demo_idempotency(a: argparse.Namespace) -> None:
    body = {"from": env("SENDRAVEN_FROM"), "to": a.to, "subject": "Idempotency demo",
            "text": "Sent once, however often it is retried."}
    key = str(uuid.uuid4())
    with client() as sr:
        first = sr.send_email(key, **body)
        again = sr.send_email(key, **body)
        print(f"same key, same body -> same message: {first['id'] == again['id']} ({first['id']})")
        try:
            sr.send_email(key, **{**body, "text": "A different message."})
        except SendRavenError as e:
            if e.type != "idempotency_key_reused":
                raise
            print("same key, different body -> 422 idempotency_key_reused, nothing sent")
        try:
            sr.send_email(**{**body, "from": "someone@unverified.example"})
        except SendRavenError as e:
            print(f"unverified from domain -> {e.status} {e.type} (needs a person: {e.needs_a_person})")


def cmd_webhook_register(a: argparse.Namespace) -> None:
    with client() as sr:
        ep = sr.create_webhook_endpoint(a.url, ["inbound", "bounce", "complaint"])
    print(f"Registered {ep['id']} for {', '.join(ep['events'])}.")
    print(f"Put this in .env as SENDRAVEN_WEBHOOK_SECRET; it is not shown again:\n{ep['secret']}")


def cmd_webhook_listen(_: argparse.Namespace) -> None:
    seen: set[str] = set()  # at-least-once delivery: dedupe (use a database in production)

    def on_event(event: dict) -> None:
        if event["type"] != "inbound":
            print(f"{event['type']} for message {event['message_id']} ({', '.join(event['to'])})")
            return
        if event["id"] in seen:
            return
        seen.add(event["id"])
        auth = "authenticated" if event["sender_authenticated"] else "UNAUTHENTICATED"
        print(f"\nReply on thread {event['thread_id']} from {event['from']} ({auth})")
        print(indent(event["text"]))
        print(f"Answer it with: python cli.py reply {event['thread_id']} \"...\"", flush=True)

    webhook.serve(env("SENDRAVEN_WEBHOOK_SECRET"), on_event, int(os.environ.get("PORT") or 3000))


def main() -> None:
    load_dotenv()
    p = argparse.ArgumentParser(description="SendRaven Python quickstart")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("usage", help="GET /v1/usage: can this workspace send right now?").set_defaults(fn=cmd_usage)
    s = sub.add_parser("send", help="POST /v1/emails")
    s.add_argument("to"), s.add_argument("subject"), s.add_argument("text")
    s.set_defaults(fn=cmd_send)
    sub.add_parser("inbox", help="threads awaiting a reply, with the latest reply").set_defaults(fn=cmd_inbox)
    s = sub.add_parser("thread", help="GET /v1/threads/{id}")
    s.add_argument("thread_id")
    s.set_defaults(fn=cmd_thread)
    s = sub.add_parser("reply", help="answer the latest inbound message on a thread")
    s.add_argument("thread_id"), s.add_argument("text"), s.add_argument("--force", action="store_true")
    s.set_defaults(fn=cmd_reply)
    s = sub.add_parser("handled", help="POST /v1/threads/{id}/handled")
    s.add_argument("thread_id")
    s.set_defaults(fn=cmd_handled)
    s = sub.add_parser("demo-idempotency", help="replay, key reuse and an error, on real calls")
    s.add_argument("to")
    s.set_defaults(fn=cmd_demo_idempotency)
    s = sub.add_parser("webhook-register", help="POST /v1/webhook-endpoints (needs webhooks:write)")
    s.add_argument("url")
    s.set_defaults(fn=cmd_webhook_register)
    sub.add_parser("webhook-listen", help="verify and print deliveries").set_defaults(fn=cmd_webhook_listen)

    args = p.parse_args()
    try:
        args.fn(args)
    except SendRavenError as e:
        print(e, file=sys.stderr)
        if e.details:
            print(e.details, file=sys.stderr)
        if e.missing:
            print(f"missing variables: {', '.join(e.missing)}", file=sys.stderr)
        if e.needs_a_person:
            print("Retrying will not help; a person has to act (see https://sendraven.ai/docs/errors).", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
