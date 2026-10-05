/**
 * Command line:
 *
 *   npm start -- start --to ana@example.com --name Ana --topic "Intro call about the API"
 *   npm start -- poll                 # wake every suspended run whose thread has a reply
 *   npm start -- poll --every 60      # ... in a loop
 *   npm start -- webhook              # resume runs from SendRaven's inbound webhook
 *   npm start -- status
 *
 * Run either `poll` or `webhook`, not both against one database: they would
 * race to resume the same run. Sends are idempotent either way, so the race
 * costs a duplicate model call, never a duplicate email.
 */

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { readWithAgent, writeWithAgent } from "./agents.js";
import { createMastra } from "./mastra.js";
import { SendRaven } from "./sendraven.js";
import { formatSlot, loadAvailability } from "./slots.js";
import { Store } from "./store.js";
import { createWebhookServer } from "./webhook.js";
import { configure, type Negotiation } from "./workflow.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    to: { type: "string" },
    name: { type: "string" },
    topic: { type: "string" },
    minutes: { type: "string", default: "30" },
    every: { type: "string" },
  },
});

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}

const sr = new SendRaven({ apiKey: env("SENDRAVEN_API_KEY"), baseUrl: process.env.SENDRAVEN_API_URL || undefined });
const store = new Store(process.env.STATE_FILE || "scheduler-state.json");
const availability = loadAvailability(process.env.AVAILABILITY_FILE || "availability.json");

configure({
  sr,
  store,
  availability,
  sender: env("SENDRAVEN_FROM"),
  maxRounds: Number(process.env.MAX_ROUNDS || 3),
  write: writeWithAgent,
  read: readWithAgent,
  now: () => new Date(),
  log: (line) => console.log(line),
});

const mastra = createMastra();
const workflow = mastra.getWorkflow("scheduleMeeting");

function report(taskId: string, result: { status: string; result?: Negotiation }) {
  if (result.status === "suspended") {
    console.log(`[${taskId}] waiting for a reply`);
    return;
  }
  const n = result.result;
  if (!n) {
    console.log(`[${taskId}] ${result.status}`);
    return;
  }
  const when = n.booked ? `: ${formatSlot(n.booked, availability.timezone)}` : "";
  console.log(`[${taskId}] ${n.status}${when}${n.note ? ` (${n.note})` : ""}`);
}

async function wake(runId: string, reason: string) {
  const run = await workflow.createRun({ runId });
  try {
    report(runId, (await run.resume({ step: "negotiate", resumeData: { reason } })) as never);
  } catch (e) {
    // Already resumed by someone else, or finished: nothing to do, but say so.
    if (String(e).includes("not suspended")) {
      console.log(`[${runId}] not suspended (already resumed or finished)`);
      return;
    }
    throw e;
  }
}

async function suspendedRuns(): Promise<string[]> {
  const { runs } = await workflow.listWorkflowRuns({ status: "suspended" });
  return runs.map((r: { runId: string }) => r.runId);
}

async function pollOnce() {
  const suspended = new Set(await suspendedRuns());
  let woken = 0;
  for (const [threadId, runId] of Object.entries(store.threads())) {
    if (!suspended.has(runId)) continue;
    // Cheap check before waking the run: only a person's reply that nobody
    // has answered, with no answer of ours already on its way.
    const t = await sr.getThread(threadId);
    if (t.awaiting_reply && !t.pending_reply) {
      woken++;
      await wake(runId, "poll");
    }
  }
  console.log(`poll: ${suspended.size} waiting, ${woken} with a new reply`);
}

async function main() {
  const command = positionals[0];

  if (command === "start") {
    if (!values.to || !values.topic) throw new Error("start needs --to and --topic");
    const taskId = randomUUID().slice(0, 8);
    const run = await workflow.createRun({ runId: taskId });
    const result = await run.start({
      inputData: {
        task_id: taskId,
        to: values.to,
        name: values.name ?? null,
        topic: values.topic,
        duration_minutes: Number(values.minutes),
      },
    });
    report(taskId, result as never);
    return;
  }

  if (command === "poll") {
    if (!values.every) return pollOnce();
    const ms = Number(values.every) * 1000;
    for (;;) {
      await pollOnce().catch((e) => console.error("poll failed:", e));
      await new Promise((r) => setTimeout(r, ms));
    }
  }

  if (command === "webhook") {
    const port = Number(process.env.PORT || 3000);
    createWebhookServer(env("SENDRAVEN_WEBHOOK_SECRET"), async (event) => {
      if (event.type !== "inbound") return;
      const runId = store.runForThread(event.thread_id);
      // Not one of ours, or an automated message: the step would re-check
      // the thread anyway, but there is no reason to wake a run for it.
      if (!runId || (event as { automated?: boolean }).automated) return;
      await wake(runId, `webhook ${event.id}`);
    }).listen(port, () => console.log(`Listening for signed webhooks on :${port}`));
    return;
  }

  if (command === "status") {
    const suspended = new Set(await suspendedRuns());
    for (const runId of Object.values(store.threads())) {
      if (suspended.has(runId)) {
        console.log(`[${runId}] waiting for a reply`);
        continue;
      }
      const state = await workflow.getWorkflowRunById(runId);
      report(runId, { status: state?.status ?? "unknown", result: (state as { result?: Negotiation } | null)?.result });
    }
    for (const b of store.bookings) console.log(`booked: ${formatSlot(b, availability.timezone)} with ${b.with} (${b.topic})`);
    return;
  }

  console.log("usage: start --to <email> --topic <text> [--name <name>] [--minutes 30] | poll [--every <seconds>] | webhook | status");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
