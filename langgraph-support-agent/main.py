"""
Support agent over email: LangGraph + SendRaven, with a person in the loop.

    python main.py run                  # one pass over threads awaiting a reply (e.g. from cron)
    python main.py run --every 300      # or keep running
    python main.py run --thread <id>    # only this thread
    python main.py run --dry-run        # classify, draft and route; send nothing, mark nothing, save nothing
    python main.py review               # decide the runs paused at the interrupt, one by one
    python main.py review <key> --send | --handled | --leave [--body-file reply.txt] [--by you@example.com]
    python main.py status               # every run and where it ended
"""

from __future__ import annotations

import argparse
import getpass
import os
import sqlite3
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.sqlite import SqliteSaver

from sendraven import SendRaven, SendRavenError
from support_graph import Ctx, Result, all_runs, build_graph, build_llm, pending_reviews, process_inbox, resume


def context(dry_run: bool = False) -> Ctx:
    key, sender = os.environ.get("SENDRAVEN_API_KEY"), os.environ.get("SUPPORT_FROM")
    if not key or not sender:
        sys.exit("Set SENDRAVEN_API_KEY and SUPPORT_FROM. Copy .env.example to .env and fill it in.")
    return Ctx(
        sr=SendRaven(key, os.environ.get("SENDRAVEN_API_URL") or None),
        llm=build_llm(os.environ.get("CLAUDE_MODEL") or "claude-opus-5-5"),
        sender=sender,
        kb=Path(os.environ.get("KNOWLEDGE_BASE") or "kb.md").read_text(),
        min_confidence=float(os.environ.get("MIN_CONFIDENCE") or 0.75),
        dry_run=dry_run,
    )


def checkpointer(dry_run: bool = False):
    if dry_run:
        return InMemorySaver()  # a dry run leaves nothing behind, so a real run starts fresh
    conn = sqlite3.connect(os.environ.get("CHECKPOINT_DB") or "support.sqlite", check_same_thread=False)
    return SqliteSaver(conn)


def show(r: Result) -> None:
    line = f"[{r.thread_id}] {r.status}"
    print(line + (f": {r.detail}" if r.detail else ""))
    if r.status == "waiting_for_review":
        print(f"    review with: python main.py review {r.key}")


def cmd_run(a) -> None:
    ctx = context(a.dry_run)
    graph = build_graph(checkpointer(a.dry_run))
    while True:
        seen = 0
        try:
            for r in process_inbox(graph, ctx, only_thread=a.thread):
                seen += 1
                show(r)
                if a.dry_run and r.review:
                    print_review(r.review, indent="    ")
        except SendRavenError as e:
            print(f"SendRaven: {e}")
            if e.needs_a_person:
                print("Retrying will not help; a person has to act.")
        if not seen:
            print("Nothing awaiting a reply.")
        if not a.every:
            return
        time.sleep(a.every)


def print_review(v: dict, indent: str = "") -> None:
    auth = "authenticated" if v["sender_authenticated"] else "NOT AUTHENTICATED (the From line may be forged)"
    lines = [
        f"From:    {v['from']} ({auth})",
        f"Subject: {v['subject']}",
        f"Intent:  {v['intent']}. {v['summary']}",
        f"Why you: {'; '.join(v['reasons'])}",
        "Customer wrote (untrusted):",
        *[f"  | {s}" for s in (v["customer_text"] or "").splitlines()],
        "Proposed reply:" if v["draft"] else "No reply drafted.",
        *[f"  > {s}" for s in (v["draft"] or "").splitlines()],
    ]
    print("\n".join(indent + s for s in lines))


def read_body() -> str:
    print("Type the reply. End with a line containing only a dot.")
    lines = []
    for line in sys.stdin:
        if line.rstrip("\n") == ".":
            break
        lines.append(line.rstrip("\n"))
    return "\n".join(lines).strip()


def cmd_review(a) -> None:
    ctx = context()
    graph = build_graph(checkpointer())
    pending = dict(pending_reviews(graph))
    if not pending:
        print("Nothing is waiting for review.")
        return
    reviewer = a.by or os.environ.get("REVIEWER") or getpass.getuser()

    if a.key:  # one run, decided from the command line
        if a.key not in pending:
            sys.exit(f"No run waiting for review under {a.key}. `python main.py review` lists them.")
        action = "send" if a.send else "handled" if a.handled else "leave" if a.leave else None
        if not action:
            print_review(pending[a.key])
            sys.exit("\nChoose --send, --handled or --leave.")
        body = Path(a.body_file).read_text().strip() if a.body_file else None
        show(resume(graph, ctx, a.key, {"action": action, "body": body, "reviewer": reviewer}))
        return

    for key, value in pending.items():  # interactive: every paused run in turn
        print(f"\n=== {key}")
        print_review(value)
        choice = input("\n[s]end the draft, [e]dit and send, mark [h]andled, [l]eave for the dashboard, s[k]ip: ").strip().lower()
        if choice in ("k", ""):
            continue
        if choice not in ("s", "e", "h", "l"):
            print("Skipped.")
            continue
        body = read_body() if choice == "e" else None
        action = {"s": "send", "e": "send", "h": "handled", "l": "leave"}[choice]
        show(resume(graph, ctx, key, {"action": action, "body": body, "reviewer": reviewer}))


def cmd_status(a) -> None:
    graph = build_graph(checkpointer())
    runs = all_runs(graph)
    if not runs:
        print("No runs yet.")
    for r in runs:
        show(r)


def main() -> None:
    load_dotenv()
    p = argparse.ArgumentParser(description="Support agent over email on LangGraph and SendRaven")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("run", help="one pass over threads awaiting a reply (or --every N seconds)")
    s.add_argument("--thread", help="only this SendRaven thread id")
    s.add_argument("--every", type=int, default=0)
    s.add_argument("--dry-run", action="store_true", help="send nothing, mark nothing, keep no checkpoints")
    s.set_defaults(fn=cmd_run)
    s = sub.add_parser("review", help="decide runs paused for a person")
    s.add_argument("key", nargs="?", help="a run key as printed by `run` (thread:message)")
    g = s.add_mutually_exclusive_group()
    g.add_argument("--send", action="store_true", help="send the draft, or --body-file instead")
    g.add_argument("--handled", action="store_true", help="send nothing and mark the thread handled")
    g.add_argument("--leave", action="store_true", help="do nothing; a person answers from the dashboard")
    s.add_argument("--body-file", help="with --send: send this text instead of the draft")
    s.add_argument("--by", help="who decided (default $REVIEWER or your login)")
    s.set_defaults(fn=cmd_review)
    sub.add_parser("status", help="every run and where it ended").set_defaults(fn=cmd_status)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
