"""The follow-up decision, without a network or a model.   python test_evaluate.py  (or pytest)"""

from datetime import datetime, timedelta, timezone

from followup import evaluate, parse_duration

NOW = datetime(2026, 9, 22, 12, 0, tzinfo=timezone.utc)
DAY = timedelta(days=1)


def out(id, days_ago, status="delivered"):
    return {"direction": "outbound", "id": id, "status": status, "at": (NOW - days_ago * DAY).isoformat().replace("+00:00", "Z")}


def inbound(days_ago, text="hi"):
    return {"direction": "inbound", "id": "in", "text": text, "sender_authenticated": True,
            "at": (NOW - days_ago * DAY).isoformat().replace("+00:00", "Z")}


def thread(*messages, awaiting_reply=False, handled_at=None):
    return {"awaiting_reply": awaiting_reply, "handled_at": handled_at, "messages": list(messages)}


def decide(t, ids=None):
    return evaluate(t, max_followups=2, delay=3 * DAY, now=NOW, our_ids=ids)


def test_waits_for_the_delay():
    d = decide(thread(out("a", 1)))
    assert d.state == "waiting" and d.next_due_at == NOW + 2 * DAY


def test_due_after_the_delay_replying_to_our_last_message():
    d = decide(thread(out("a", 7), out("b", 4)), {"a", "b"})
    assert d.state == "due" and d.followups_sent == 1 and d.last_outbound_id == "b"


def test_stops_after_max_followups():
    assert decide(thread(out("a", 12), out("b", 8), out("c", 4))).state == "exhausted"


def test_a_real_reply_wins():
    assert decide(thread(out("a", 7), inbound(1), awaiting_reply=True)).state == "replied"


def test_an_out_of_office_is_not_a_reply():
    # SendRaven records it on the thread but leaves awaiting_reply false.
    assert decide(thread(out("a", 7), inbound(6, "I am away"))).state == "due"


def test_a_held_or_scheduled_message_blocks_another():
    assert decide(thread(out("a", 7), out("b", 0, status="queued"))).state == "pending"


def test_bounced_or_failed_mail():
    assert decide(thread(out("a", 7, status="bounced"))).state == "undeliverable"
    assert decide(thread(out("a", 7, status="failed"))).state == "undeliverable"


def test_someone_else_answered_or_marked_handled():
    assert decide(thread(out("a", 7), out("colleague", 5)), {"a"}).state == "handled"
    assert decide(thread(out("a", 7), handled_at="2026-09-20T00:00:00.000Z")).state == "handled"


def test_parse_duration():
    assert parse_duration("3d") == 3 * DAY and parse_duration("90m") == timedelta(minutes=90)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
