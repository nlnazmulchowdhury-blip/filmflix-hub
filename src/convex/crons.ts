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

export default crons;