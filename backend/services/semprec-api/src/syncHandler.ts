import type { IncomingMessage } from "node:http";
import type { Pool } from "pg";
import { UnauthorizedError, isSessionActive } from "@semprec/data";
import { createSyncServer, type SyncServer } from "@semprec/realtime";
import { authenticateRequest } from "./authHandler.js";

/**
 * `WS /api/sync` (issue #160): wires `@semprec/realtime`'s protocol-v1 sync server to this
 * service's real session verification — the same `authenticateRequest` every other authenticated
 * route uses, so a cookie or Bearer session reaches the same authenticated socket identity as it
 * would an HTTP request. An invalid/expired/revoked credential never completes the WS handshake.
 */
export async function createSyncUpgradeHandler(pool: Pool): Promise<SyncServer> {
  return createSyncServer(pool, {
    authenticate: async (req: IncomingMessage) => {
      try {
        const identity = await authenticateRequest(pool, req);
        return { userId: identity.user.id, sessionId: identity.session.id };
      } catch (err) {
        if (err instanceof UnauthorizedError) return null;
        throw err;
      }
    },
    revalidateSession: (sessionId: string) => isSessionActive(pool, sessionId),
  });
}
