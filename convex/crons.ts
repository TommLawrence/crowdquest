import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();
crons.daily("prune-old-event-deduplication-records", { hourUTC: 3, minuteUTC: 15 }, internal.state.pruneProcessedEvents, {});

export default crons;
