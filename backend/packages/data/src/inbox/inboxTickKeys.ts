export const SEMPREC_TICK_ACTION_ID = "semprec.tick";

/** Base lane name for `semprec.tick`; enqueue appends the tenant (`semprec-tick:<tenantId>`), so one tenant's Inbox ticks serialize against each other. */
export const SEMPREC_TICK_QUEUE_NAME = "semprec-tick";
