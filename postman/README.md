# SendRaven Postman collection

Every `/v1` endpoint, grouped by resource, plus a **Start here** folder that
runs the round trip: check the workspace can send, list threads awaiting a
reply, read one, and reply in the same conversation.

1. In Postman: Import, then choose `SendRaven.postman_collection.json`.
2. Put your API key in the collection variable `api_key` (current value only,
   so it is never synced), and set `from` to a sender on your verified domain.
3. Run the four requests in **Start here** in order.

Sends get a fresh `Idempotency-Key` automatically. The collection is generated
from https://sendraven.ai/openapi.json; the read-only requests were run against
the production API before publishing.
