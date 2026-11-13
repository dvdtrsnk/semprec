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
 * Composes the gateway's HTTP server over `pool`, for `serve.ts` and for the suites that drive the process
 * as it runs. Issue gh-2023: the process announces the first refusal of a tenant's budget window as a Semp
 * status invalidation through the data layer's in-process realtime hooks, whose defaults are no-ops, so the
 * hooks are wired here, over the process's own pool, before any request can reach the server. Keeping the call
 * in this function is what lets a suite fail when it goes missing; `serve.ts` only adds what a running process
 * needs around the server.
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
