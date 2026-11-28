export const ALLDOTS_TICK_ACTION_ID = "alldots.tick";

/** Base lane name for `alldots.tick`; enqueue appends the tenant (`alldots-tick:<tenantId>`), so one tenant's Inbox ticks serialize against each other. */
export const ALLDOTS_TICK_QUEUE_NAME = "alldots-tick";
