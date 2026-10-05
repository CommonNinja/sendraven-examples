/**
 * The Mastra instance. LibSQL keeps workflow snapshots in a local file, which
 * is what lets a run suspend on Monday and resume on Thursday in a different
 * process. Point `url` at Turso (or swap in @mastra/pg) to run it on a server.
 */

import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { readerAgent, writerAgent } from "./agents.js";
import { scheduleMeeting } from "./workflow.js";

export function createMastra(url = process.env.MASTRA_DB_URL || "file:./scheduler.db") {
  return new Mastra({
    agents: { writerAgent, readerAgent },
    workflows: { scheduleMeeting },
    storage: new LibSQLStore({ id: "scheduler-storage", url }),
  });
}
