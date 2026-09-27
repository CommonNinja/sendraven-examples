"""
Vendor quotes over email: CrewAI + SendRaven, with a person in the loop.

    python main.py send                   # mail the request to every vendor in vendors.csv that has not had it
    python main.py collect                # read every vendor's thread and act on new replies (e.g. from cron)
    python main.py collect --every 600    # or keep running
    python main.py collect --vendor <name or email>
    python main.py send --dry-run         # write and show; send nothing, keep nothing (also for collect)
    python main.py review                 # decide the runs paused for a person, one by one
    python main.py review <key> --send | --close | --leave [--body-file reply.txt] [--by you@example.com]
    python main.py status                 # every vendor, and every run and where it ended
    python main.py report                 # the quotes side by side, written to quotes.md
"""

from __future__ import annotations

import os

# Before crewai is imported: no telemetry, and no interactive prompt offering
# to upload an execution trace. The prompts here include vendors' emails.
os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")
os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")

import argparse
import csv
import getpass
import json
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from crewai.flow.persistence import SQLiteFlowPersistence  # noqa: E402

from crews import QuoteCrews, build_llm  # noqa: E402
from quote_flow import Ctx, Ledger, Result, collect, comparison, resume, send_rfqs  # noqa: E402
from sendraven import SendRaven, SendRavenError  # noqa: E402

DB = os.environ.get("QUOTES_DB") or "quotes.sqlite"


def context(dry_run: bool = False) -> Ctx:
    key, sender, rfq_id = (os.environ.get(k) for k in ("SENDRAVEN_API_KEY", "PURCHASING_FROM", "RFQ_ID"))
    if not key or not sender or not rfq_id:
        sys.exit("Set SENDRAVEN_API_KEY, PURCHASING_FROM and RFQ_ID. Copy .env.example to .env and fill it in.")
    return Ctx(
        sr=SendRaven(key, os.environ.get("SENDRAVEN_API_URL") or None),
        crews=QuoteCrews(build_llm(os.environ.get("CLAUDE_MODEL") or "claude-opus-5-5")),
        sender=sender,
        request=Path(os.environ.get("REQUEST") or "request.md").read_text(),
        rfq_id=rfq_id,
        dry_run=dry_run,
    )


def read_vendors() -> list[dict]:
    with open(os.environ.get("VENDORS") or "vendors.csv", newline="") as f:
        return [{k: (v or "").strip() for k, v in row.items()} for row in csv.DictReader(f)]


def show(r: Result) -> None:
    print(f"[{r.vendor}] {r.status}" + (f": {r.detail}" if r.detail else ""))
    if r.status == "waiting_for_review":
        print(f"    review with: python main.py review {r.key}")


def cmd_send(a) -> None:
    ctx = context(a.dry_run)
    for r in send_rfqs(ctx, Ledger(DB), read_vendors()):
        show(r)


def cmd_collect(a) -> None:
    ctx = context(a.dry_run)
    ledger, persistence = Ledger(DB), SQLiteFlowPersistence(DB)
    while True:
        try:
            for r in collect(ctx, ledger, persistence, a.vendor):
                show(r)
        except SendRavenError as e:
            if not a.every:
                raise
            print(f"pass failed, trying again next time: {e}", file=sys.stderr)
        if not a.every:
            return
        time.sleep(a.every)


def cmd_review(a) -> None:
    ctx, ledger, persistence = context(), Ledger(DB), SQLiteFlowPersistence(DB)
    reviewer = a.by or os.environ.get("REVIEWER") or getpass.getuser()
    if a.key:
        action = "send" if a.send else "close" if a.close else "leave" if a.leave else None
        if not action:
            sys.exit("Say what to do: --send, --close or --leave.")
        body = Path(a.body_file).read_text() if a.body_file else None
        show(resume(ctx, ledger, persistence, a.key, {"action": action, "body": body, "reviewer": reviewer}))
        return
    waiting = ledger.runs("waiting_for_review")
    if not waiting:
        print("Nothing is waiting for review.")
        return
    for run in waiting:
        p = json.loads(run["preview"])
        print("=" * 72)
        print(f"{p['vendor']}  <{p['from']}>" + ("" if p["sender_authenticated"] else "  (SENDER NOT AUTHENTICATED)"))
        print(f"Subject: {p['subject']}\nWhy you: " + "; ".join(p["reasons"]))
        print(f"\n--- what they wrote ---\n{p['vendor_text']}")
        print(f"\n--- their quote so far ---\n{json.dumps(p['quote'], indent=2)}")
        if p["missing"]:
            print("Still missing: " + ", ".join(p["missing"]))
        print(f"\n--- proposed reply ---\n{p['draft'] or '(none)'}\n")
        choice = input("[s]end the reply, [e]dit and send, [c]lose the thread, [l]eave it for the dashboard, [n]ext: ").strip().lower()
        decision = {"reviewer": reviewer}
        if choice == "s" and p["draft"]:
            decision["action"] = "send"
        elif choice in ("s", "e"):
            print("Type the reply. End with a line containing only a dot.")
            lines = []
            while (line := input()) != ".":
                lines.append(line)
            decision.update(action="send", body="\n".join(lines))
        elif choice == "c":
            decision["action"] = "close"
        elif choice == "l":
            decision["action"] = "leave"
        else:
            continue
        show(resume(ctx, ledger, persistence, run["key"], decision))


def cmd_status(a) -> None:
    ledger = Ledger(DB)
    for v in ledger.vendors():
        q = ledger.quote(v["email"])
        state = "declined" if q["declined"] else "quote complete" if not q["missing"] else f"missing {len(q['missing'])} field(s)"
        print(f"{v['vendor']:<28} request {v['rfq_status'] or 'not sent':<18} {state}")
    for run in ledger.runs():
        print(f"  {run['key']}  {run['status']}: {run['detail']}")


def cmd_report(a) -> None:
    text = comparison(Ledger(DB))
    Path(a.out).write_text(text)
    print(text)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("send")
    s.add_argument("--dry-run", action="store_true")
    s.set_defaults(fn=cmd_send)
    c = sub.add_parser("collect")
    c.add_argument("--dry-run", action="store_true")
    c.add_argument("--every", type=int, default=0, help="seconds between passes")
    c.add_argument("--vendor")
    c.set_defaults(fn=cmd_collect)
    r = sub.add_parser("review")
    r.add_argument("key", nargs="?")
    g = r.add_mutually_exclusive_group()
    g.add_argument("--send", action="store_true")
    g.add_argument("--close", action="store_true")
    g.add_argument("--leave", action="store_true")
    r.add_argument("--body-file")
    r.add_argument("--by")
    r.set_defaults(fn=cmd_review)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    rep = sub.add_parser("report")
    rep.add_argument("--out", default="quotes.md")
    rep.set_defaults(fn=cmd_report)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
