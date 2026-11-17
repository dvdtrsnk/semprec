import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Pool } from "pg";
import { UnauthorizedError, isSessionActive } from "@semprec/data";
import { createSyncServer, type SyncServer } from "@semprec/realtime";
import { authenticateRequest } from "./authHandler.js";
import { isAllowedOrigin } from "./originCheck.js";

/**
 * Uses the same `authenticateRequest` as every HTTP route, so a cookie or Bearer session reaches
 * the same socket identity. An invalid, expired or revoked credential never completes the
 * handshake.
 */
export async function createSyncUpgradeHandler(pool: Pool): Promise<SyncServer> {
  const syncServer = await createSyncServer(pool, {
    authenticate: async (req: IncomingMessage) => {
      try {
        const identity = await authenticateRequest(pool, req);
        return { tenantId: identity.tenantId, userId: identity.user.id, sessionId: identity.session.id };
      } catch (err) {
        if (err instanceof UnauthorizedError) return null;
        throw err;
      }
    },
    revalidateSession: (sessionId: string) => isSessionActive(pool, sessionId),
  });

  // A cookie-authenticated socket from a foreign origin is refused before `authenticate` runs; the
  // 403 is written on the raw socket, as the sync server writes its 401.
  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!isAllowedOrigin(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    syncServer.handleUpgrade(req, socket, head);
  };
  return { ...syncServer, handleUpgrade };
}
