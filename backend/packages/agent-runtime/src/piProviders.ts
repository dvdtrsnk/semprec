/** The subset of pi-agent-core's provider-registration surface this seam is written against
 * (pi-agent-core has not published TypeScript types yet — same situation as
 * `CreateAgentSession` in types.ts). */
export interface PiProviderRegistry {
  registerProvider(name: string, config: { baseUrl: string }): void;
}

/** Every provider #120 requires routed through the gateway. */
const GATEWAY_ROUTED_PI_PROVIDERS = ["anthropic", "openai"] as const;

/**
 * Registers the AI gateway as the `baseUrl` for every pi-supported provider, so no
 * `AgentSession` — Semp's, delegated, or any future type — can construct its own provider
 * client and bypass the gateway's accounting and budget check.
 *
 * Call this exactly once, at process startup, before creating any `AgentSession` — not per
 * session, not per call. No caller exists yet: `services/semprec-agents`, the composition
 * root that owns process startup, is a future issue's deliverable (same situation as
 * `repairInterruptedRuns` in startupRepair.ts). That service must call this once with the
 * real `pi` module and this gateway's own `baseUrl`.
 */
export function registerPiProviders(pi: PiProviderRegistry, baseUrl: string): void {
  for (const provider of GATEWAY_ROUTED_PI_PROVIDERS) {
    pi.registerProvider(provider, { baseUrl });
  }
}
