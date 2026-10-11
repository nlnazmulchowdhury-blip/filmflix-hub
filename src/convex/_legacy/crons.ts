import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Re-probe every movie + TV stream URL every 6 hours.
crons.interval(
  "link-health-check",
  { hours: 6 },
  internal.linkHealth.checkAllCron,
  {},
);

// Sweep cloud storage hourly: delete uploaded files no movie references
// anymore (24h grace period protects in-progress upload form sessions).
crons.interval(
  "storage-orphan-sweep",
  { hours: 1 },
  internal.storageCleanup.sweepOrphans,
  {},
);

export default crons;