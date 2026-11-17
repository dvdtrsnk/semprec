import type { Pool } from "pg";
import { startSempTurnCancelListener, type SempTurnCancelListener } from "@semprec/data";
import type { InFlightAgentRuns } from "./inFlightAgentRuns.js";
import { logger } from "./logger.js";

/**
 * Aborts the Semp turn named by every cancel request that reaches this process. A request for a turn this process does
 * not run, or for a message id of another tenant, finds nothing in `inFlight` and is ignored.
 */
export function startSempTurnCancelWiring(pool: Pool, inFlight: InFlightAgentRuns): Promise<SempTurnCancelListener> {
  return startSempTurnCancelListener(pool, ({ tenantId, assistantMessageId }) => {
    if (inFlight.abortTurn(tenantId, assistantMessageId)) {
      logger.info({ tenantId, assistantMessageId }, "Aborted a running Semp turn on request");
    }
  });
}
