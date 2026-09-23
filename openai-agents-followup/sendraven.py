"""
A minimal SendRaven client on httpx. No SDK: there is no SendRaven PyPI
package, and the REST API is small enough that one file covers what an agent
needs. Field names match the API exactly (snake_case).

Docs: https://sendraven.ai/docs  ·  Schema: https://sendraven.ai/openapi.json
"""

from __future__ import annotations

import random
import time
import uuid
from typing import Any, Iterator, Optional

import httpx

DEFAULT_BASE_URL = "https://api.sendraven.ai"

# Refusals nothing in the request can fix: stop and tell a person.
NEEDS_A_PERSON = {
    "payment_method_required",
    "plan_limit_reached",
    "billing_past_due",
    "workspace_suspended",
    "no_postal_address",
    "no_verified_identity",
    "recipient_not_allowed",
    "forbidden",
}
# Conditions that clear by themselves: the same request can be sent again.
RETRYABLE = {"idempotency_in_progress", "rate_limited", "approval_in_progress"}


class SendRavenError(Exception):
    """The API's one error shape: {"error": {"type", "message", "details"?, "missing"?}}.

    Branch on `type`, never on `message` (which is for people and may change).
    """

    def __init__(self, status: int, type: str, message: str, details: Any = None, missing: Any = None):
        super().__init__(f"{status} {type}: {message}")
        self.status = status
        self.type = type
        self.message = message
        self.details = details
        self.missing = missing

    @property
    def retryable(self) -> bool:
        return self.type in RETRYABLE

    @property
    def needs_a_person(self) -> bool:
        return self.type in NEEDS_A_PERSON


class SendRaven:
    def __init__(self, api_key: str, base_url: Optional[str] = None, timeout: float = 15.0, max_attempts: int = 3):
        if not api_key:
            raise ValueError("SENDRAVEN_API_KEY is not set")
        # Keep the timeout above 10 s: a duplicate request waits up to 8 s for the first.
        self._http = httpx.Client(
            base_url=(base_url or DEFAULT_BASE_URL).rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
            timeout=timeout,
        )
        self._max_attempts = max_attempts

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "SendRaven":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Optional[dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        """One request, with retries that cannot double-send.

        - A network error or timeout is retried with the SAME Idempotency-Key,
          so if the first attempt did send, the retry gets its stored answer.
        - 409 idempotency_in_progress and 429 rate_limited are retried after a pause.
        - Everything else raises SendRavenError. 500 and 502 are NOT retried:
          errors are never stored against a key, so a retry would act again.
        """
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else {}
        params = {k: _q(v) for k, v in (params or {}).items() if v is not None}
        last: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                res = self._http.request(method, path, json=json, params=params, headers=headers)
            except httpx.TransportError as e:
                # We do not know whether the server acted. Only safe to retry
                # when an Idempotency-Key turns the retry into a replay.
                last = e
                if method == "GET" or idempotency_key:
                    time.sleep(_backoff(attempt))
                    continue
                raise
            if res.is_success:
                return res.json() if res.content else None
            err = (res.json() if res.content else {}).get("error", {})
            error = SendRavenError(res.status_code, err.get("type", "unknown"), err.get("message", res.reason_phrase),
                                   err.get("details"), err.get("missing"))
            # daily_limit is also a 429 but it means stop until 00:00 UTC, not back off.
            if error.retryable and attempt < self._max_attempts:
                last = error
                time.sleep(_backoff(attempt))
                continue
            raise error
        assert last is not None
        raise last

    # ------------------------------------------------------------ email

    def send_email(self, idempotency_key: Optional[str] = None, **body: Any) -> dict:
        """POST /v1/emails. Keyword arguments are the body fields: from_ (or
        "from" via **{"from": ...}), to, subject, text, html, reply_to_message_id, ...

        Pass an idempotency_key you can reproduce (derived from your own job
        id) so a crash-and-rerun cannot mail the same person twice. A random
        UUID only covers retries within this call.

        The answer always has id, status, thread_id, scheduled_at, skipped,
        reason and approval_id. status is sent, scheduled, pending_approval or
        rejected; none of them is an error and none should be retried.
        """
        if "from_" in body:
            body["from"] = body.pop("from_")
        return self.request("POST", "/v1/emails", json=body, idempotency_key=idempotency_key or str(uuid.uuid4()))

    def get_email(self, message_id: str) -> dict:
        return self.request("GET", f"/v1/emails/{message_id}")

    def cancel_scheduled_email(self, message_id: str) -> dict:
        """Stops a message whose status is `scheduled`; anything else is 409 invalid_state."""
        return self.request("DELETE", f"/v1/emails/{message_id}")

    # ------------------------------------------------------------ threads

    def list_threads(self, awaiting_reply: Optional[bool] = None, limit: Optional[int] = None,
                     cursor: Optional[str] = None) -> dict:
        return self.request("GET", "/v1/threads",
                            params={"awaiting_reply": awaiting_reply, "limit": limit, "cursor": cursor})

    def iter_threads(self, awaiting_reply: Optional[bool] = None) -> Iterator[dict]:
        """Every thread matching the filter, following next_cursor while has_more."""
        cursor = None
        while True:
            page = self.list_threads(awaiting_reply=awaiting_reply, limit=100, cursor=cursor)
            yield from page["data"]
            if not page["has_more"] or not page["next_cursor"]:
                return
            cursor = page["next_cursor"]

    def get_thread(self, thread_id: str) -> dict:
        return self.request("GET", f"/v1/threads/{thread_id}")

    def mark_thread_handled(self, thread_id: str) -> dict:
        """Clears awaiting_reply without mailing anyone ("thanks, all sorted")."""
        return self.request("POST", f"/v1/threads/{thread_id}/handled")

    # ------------------------------------------------------------ account

    def get_usage(self) -> dict:
        return self.request("GET", "/v1/usage")

    def create_webhook_endpoint(self, url: str, events: list[str]) -> dict:
        """Needs webhooks:write. The `secret` in the answer is shown only this once."""
        return self.request("POST", "/v1/webhook-endpoints", json={"url": url, "events": events},
                            idempotency_key=str(uuid.uuid4()))


# ---------------------------------------------------------------- helpers

def latest_inbound(thread: dict) -> Optional[dict]:
    """The newest inbound entry of a transcript: the one to answer."""
    return next((m for m in reversed(thread["messages"]) if m["direction"] == "inbound"), None)


def has_pending_reply(thread: dict) -> bool:
    """True when a reply we wrote is waiting to go out: held for approval
    (`queued`) or `scheduled`, after the latest inbound message.

    awaiting_reply only clears when a reply is actually sent, so an agent
    polling awaiting_reply=true with an approval-held key must skip threads
    whose `pending_reply` is true, or it drafts the same answer on every run."""
    return bool(thread.get("pending_reply"))


def reply_subject(subject: str) -> str:
    return subject if subject.lower().startswith("re:") else f"Re: {subject}"


def _q(v: Any) -> str:
    return ("true" if v else "false") if isinstance(v, bool) else str(v)


def _backoff(attempt: int) -> float:
    return min(8.0, 0.5 * 2 ** (attempt - 1)) + random.random() / 4
