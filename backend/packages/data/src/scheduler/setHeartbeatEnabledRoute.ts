import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import type { HeartbeatRuleKindRegistry } from "./rule.js";
import { lockHeartbeatForManualFire, setHeartbeatEnabled } from "./schedulerStore.js";
import type { RouteParams, RouteBody } from "../customRoute.js";
import { requireUuidParam } from "../customRoute.js";

interface Dependencies {
  heartbeatRuleKinds?: () => Promise<HeartbeatRuleKindRegistry>;
}
const bodySchema = z.object({ enabled: z.boolean() }).strict();

export function createSetHeartbeatEnabledRouteHandler(pool: Pool, dependencies: Dependencies = {}) {
  return async (ctx: RouteParams & RouteBody) => {
    const id = requireUuidParam(ctx.params, "id");
    const body = bodySchema.safeParse(ctx.body);
    if (!body.success) throw new ValidationError("Invalid heartbeat update", { field: "enabled" });
    let ruleKinds: HeartbeatRuleKindRegistry = new Map();
    if (body.data.enabled) {
      if (!dependencies.heartbeatRuleKinds) throw new Error("Heartbeat rule registry is not configured");
      ruleKinds = await dependencies.heartbeatRuleKinds();
    }
    const heartbeat = await withTransaction(pool, async (client) => {
      const current = await lockHeartbeatForManualFire(client, id, null, ruleKinds);
      if (!current) throw new NotFoundError("Heartbeat not found");
      if (current.origin === "system")
        throw new ForbiddenError("System heartbeat cannot be changed", undefined, "owner_violation");
      return setHeartbeatEnabled(client, id, body.data.enabled, ruleKinds);
    });
    return { status: 200, body: { id: heartbeat.id, enabled: heartbeat.enabled, nextFireAt: heartbeat.nextFireAt } };
  };
}
