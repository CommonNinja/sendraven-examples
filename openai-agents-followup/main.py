"""
Follow-up agent: send an email, follow up politely in the same thread until
the person replies (at most MAX_FOLLOWUPS times), then read and summarise the
reply.

    python main.py start --to lead@example.org --goal "Ask whether Thursday 10:00 works for a 20-minute call"
    python main.py poll              # run once, e.g. from cron every 15 minutes
    python main.py poll --every 300  # or keep running
    python main.py webhook           # react to replies at once, and check for due follow-ups on a timer
    python main.py status
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import threading
import time

from dotenv import load_dotenv

from agents import set_tracing_disabled
from followup import Config, Store, build_agents, evaluate, start, step
from sendraven import SendRaven, SendRavenError
import webhook

# One pass at a time per process: the webhook handler and the timer share the store.
_lock = threading.Lock()


def client() -> SendRaven:
    key = os.environ.get("SENDRAVEN_API_KEY")
    if not key:
        sys.exit("Missing SENDRAVEN_API_KEY. Copy .env.example to .env and fill it in.")
    return SendRaven(key, os.environ.get("SENDRAVEN_API_URL") or None)


def poll_once(sr: SendRaven, cfg: Config, agents: dict) -> None:
    with _lock:
        store = Store(cfg.state_path)
        active = [c for c in store.campaigns.values() if c["status"] not in ("done", "exhausted", "undeliverable", "handled")]
        if not active:
            print("No active follow-ups.")
        for camp in active:
            try:
                asyncio.run(step(sr, cfg, store, camp, agents))
            except SendRavenError as e:
                print(f"[{camp['id']}] {e}")
                if e.needs_a_person:
                    print(f"[{camp['id']}] Retrying will not help; a person has to act.")


def cmd_start(a, sr, cfg, agents):
    with _lock:
        asyncio.run(start(sr, cfg, Store(cfg.state_path), a.to, a.goal, agents))


def cmd_poll(a, sr, cfg, agents):
    while True:
        poll_once(sr, cfg, agents)
        if not a.every:
            return
        time.sleep(a.every)


def cmd_status(a, sr, cfg, agents):
    store = Store(cfg.state_path)
    for c in store.campaigns.values():
        line = f"{c['id']}  {c['status']:<13} {c['to']:<30} {c.get('subject') or ''}"
        if c.get("thread_id") and c["status"] not in ("done", "exhausted", "undeliverable", "handled"):
            d = evaluate(sr.get_thread(c["thread_id"]), cfg.max_followups, cfg.delay, our_ids=set(c.get("sent_ids", [])))
            line += f"  [{d.state}, {d.followups_sent}/{cfg.max_followups} follow-ups]"
        print(line)
        if c.get("result"):
            print(f"    {c['result']['summary']}")


def cmd_webhook(a, sr, cfg, agents):
    secret = os.environ.get("SENDRAVEN_WEBHOOK_SECRET")
    if not secret:
        sys.exit("Missing SENDRAVEN_WEBHOOK_SECRET (printed once when the endpoint is created).")

    def on_event(event: dict) -> None:
        if event.get("type") != "inbound":
            return
        with _lock:
            store = Store(cfg.state_path)
            camp = store.by_thread(event["thread_id"])
            if not camp:
                return  # a reply on a thread this agent does not own
            if event.get("automated"):
                return  # an out-of-office or a bounce report: not an answer
            # Never act on the event's text: step() re-reads the thread and
            # trusts awaiting_reply, which only mail from a person sets.
            asyncio.run(step(sr, cfg, store, camp, agents))

    # Replies arrive by webhook; follow-ups still need a clock.
    def timer():
        while True:
            time.sleep(a.every)
            poll_once(sr, cfg, agents)

    threading.Thread(target=timer, daemon=True).start()
    webhook.serve(secret, on_event, int(os.environ.get("PORT") or 3000))


def main() -> None:
    load_dotenv()
    if os.environ.get("OPENAI_AGENTS_DISABLE_TRACING") == "1":
        set_tracing_disabled(True)
    p = argparse.ArgumentParser(description="Follow-up agent on the OpenAI Agents SDK and SendRaven")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("start", help="write and send the first email")
    s.add_argument("--to", required=True)
    s.add_argument("--goal", required=True, help="what you need from this person, in one sentence")
    s.set_defaults(fn=cmd_start)
    s = sub.add_parser("poll", help="check every active task once (or --every N seconds)")
    s.add_argument("--every", type=int, default=0)
    s.set_defaults(fn=cmd_poll)
    sub.add_parser("status", help="list tasks and where each one stands").set_defaults(fn=cmd_status)
    s = sub.add_parser("webhook", help="handle the inbound webhook, and check for due follow-ups on a timer")
    s.add_argument("--every", type=int, default=900, help="seconds between follow-up checks (default 900)")
    s.set_defaults(fn=cmd_webhook)
    a = p.parse_args()

    cfg = Config.from_env()
    with client() as sr:
        a.fn(a, sr, cfg, build_agents(cfg.model))


if __name__ == "__main__":
    main()
