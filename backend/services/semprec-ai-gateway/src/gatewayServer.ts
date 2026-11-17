import { createServer, type Server } from "node:http";
import type { Pool } from "pg";
import { wireRealtimeHooks } from "@semprec/realtime";
import { createDispatcher, createUpgradeDispatcher } from "./app.js";
import { createSttStreamUpgradeHandler, type SttStreamUpgradeHandler } from "./sttStreamHandler.js";
import type { StartupConfig } from "./startupConfig.js";

export interface GatewayServer {
  /** Not listening yet: the caller binds it, so the hooks below are wired before the first request. */
  server: Server;
  sttStreams: SttStreamUpgradeHandler;
}

/**
 * Wires the realtime hooks (no-ops by default) before any request arrives, so budget refusals are
 * announced. Kept here rather than in `serve.ts` so a suite fails if the wiring goes missing.
 */
export function createGatewayServer(pool: Pool, config: StartupConfig): GatewayServer {
  wireRealtimeHooks(pool);

  const dispatch = createDispatcher(
    pool,
    config.handlerOptions,
    config.audioHandlerOptions,
    config.piHandlerOptions,
    config.ttsStreamHandlerOptions,
  );
  const server = createServer(dispatch);

  const sttStreams = createSttStreamUpgradeHandler(pool, config.sttStreamHandlerOptions);
  server.on("upgrade", createUpgradeDispatcher(sttStreams));

  return { server, sttStreams };
}
