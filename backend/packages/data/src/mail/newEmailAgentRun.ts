// `coreAgentRunAction` cannot import the mail resolvers (`scheduler/actions.ts` is imported by the choke
// point, which the mail module imports), so the agents composition root passes them in.
import type { Pool } from "pg";
import type { AiGatewayClientPort } from "@semprec/shared";
import type { CoreAgentRunDependencies } from "../scheduler/actions.js";
import { createAnswerExpectedGate } from "../scheduler/answerExpectedFilter.js";
import { resolveMailThreadRunProject } from "./newEmailRunProject.js";

/** Without a `gateway` there is no gate, and a heartbeat with `answerExpectedFilter` on fails when it fires. */
export function createNewEmailAgentRunDependencies(
  pool: Pool,
  gateway?: AiGatewayClientPort,
): CoreAgentRunDependencies {
  return {
    runProjectResolvers: { mailThreadProject: (input) => resolveMailThreadRunProject(pool, input) },
    ...(gateway === undefined ? {} : { answerExpectedGate: createAnswerExpectedGate(pool, gateway) }),
  };
}
