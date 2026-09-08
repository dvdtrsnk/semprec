import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "../../components/StateViews.js";
import { useTranslate } from "../../i18n/index.js";
import { toOperationError, type OperationError } from "../../api/genericOperations.js";
import type { McpAgentPageOperations, McpToolGrant } from "../../api/mcpAgentPageOperations.js";

type ToolsResource =
  | { status: "loading" }
  | { status: "ready"; rows: McpToolGrant[]; refreshing: boolean }
  | { status: "failed"; error: OperationError };

interface RowMutationState {
  pending: boolean;
  error: string | null;
}

/**
 * Loads the block's rows and exposes a `refresh` that keeps the currently-rendered rows on
 * screen while it runs (the "concurrent-refresh" state issue #127 asks for) instead of
 * flipping the whole block back to a blank loading spinner — only the very first load, with
 * nothing to show yet, uses the full `LoadingState`.
 */
function useMcpToolGrants(operations: McpAgentPageOperations, projectItemId: string) {
  const [resource, setResource] = useState<ToolsResource>({ status: "loading" });
  const mounted = useRef(true);
  // Guards against out-of-order responses: two overlapping `load` calls (e.g. two mutations
  // each triggering their own `refresh`) can resolve in either order, and only the response to
  // the most-recently-started request should ever be applied.
  const loadGeneration = useRef(0);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const load = useCallback(
    async (background: boolean) => {
      const generation = ++loadGeneration.current;
      if (background) {
        setResource((prev) => (prev.status === "ready" ? { ...prev, refreshing: true } : prev));
      } else {
        setResource({ status: "loading" });
      }
      try {
        const rows = await operations.listMcpToolGrants(projectItemId);
        if (mounted.current && generation === loadGeneration.current) setResource({ status: "ready", rows, refreshing: false });
      } catch (error) {
        if (!mounted.current || generation !== loadGeneration.current) return;
        setResource((prev) =>
          // A failed background refresh doesn't discard rows already on screen — only a
          // failed *initial* load (nothing to show yet) becomes the full error state.
          prev.status === "ready" ? { ...prev, refreshing: false } : { status: "failed", error: toOperationError(error) },
        );
      }
    },
    [operations, projectItemId],
  );

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operations, projectItemId]);

  return { resource, reload: () => load(false), refresh: () => load(true) };
}

function ServerOnlineBadge({ online }: { online: boolean }) {
  const t = useTranslate();
  if (online) return null;
  return <span className="agent-tools__badge agent-tools__badge--offline">{t("agentPage.tools.transportOffline")}</span>;
}

function ToolRow({
  row,
  mutation,
  onToggleGrant,
  onReclassify,
}: {
  row: McpToolGrant;
  mutation: RowMutationState | undefined;
  onToggleGrant: (row: McpToolGrant, granted: boolean) => void;
  onReclassify: (row: McpToolGrant, patch: { riskClass?: string; requiresApproval?: boolean }) => void;
}) {
  const t = useTranslate();
  const pending = mutation?.pending ?? false;

  return (
    <li className="agent-tools__row">
      <label className="agent-tools__checkbox">
        <input
          type="checkbox"
          checked={row.granted}
          disabled={pending}
          onChange={(event) => onToggleGrant(row, event.target.checked)}
        />
        <span className="agent-tools__tool-name">{row.toolName}</span>
      </label>
      {row.description ? <p className="agent-tools__description">{row.description}</p> : null}
      <div className="agent-tools__classification">
        <label>
          {t("agentPage.tools.riskClass")}
          <select value={row.riskClass} disabled={pending} onChange={(event) => onReclassify(row, { riskClass: event.target.value })}>
            {[row.riskClass, "unclassified", "low", "moderate", "high", "destructive"]
              .filter((value, index, all) => all.indexOf(value) === index)
              .map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={row.requiresApproval}
            disabled={pending}
            onChange={(event) => onReclassify(row, { requiresApproval: event.target.checked })}
          />
          {t("agentPage.tools.requiresApproval")}
        </label>
      </div>
      {mutation?.error ? (
        <p className="agent-tools__row-error" role="alert">
          {t("agentPage.tools.mutationError", { message: mutation.error })}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The "Tools" block on a project's AGENT page (issue #127): every active MCP tool
 * registration across the whole system, grouped by the server that offers it, with a
 * checkbox bound directly to `project_mcp_grants.granted` for (this project, this tool) and
 * minimal authenticated controls to reclassify `riskClass`/`requiresApproval`.
 *
 * Mutations are pessimistic: the row's controls stay bound to the last-known server value and
 * are disabled while a write is in flight, then re-enabled once the post-mutation refresh
 * lands — rather than freezing the whole block while one row's write is in flight. A failed
 * mutation surfaces an inline per-row error instead of reverting anything, since nothing was
 * changed optimistically to revert.
 */
export function ToolsBlock({ projectItemId, operations }: { projectItemId: string; operations: McpAgentPageOperations }) {
  const t = useTranslate();
  const { resource, reload, refresh } = useMcpToolGrants(operations, projectItemId);
  const [mutations, setMutations] = useState<Record<string, RowMutationState>>({});

  const withMutation = useCallback(
    async (row: McpToolGrant, run: () => Promise<void>) => {
      setMutations((prev) => ({ ...prev, [row.mcpToolRegistrationId]: { pending: true, error: null } }));
      try {
        await run();
        setMutations((prev) => ({ ...prev, [row.mcpToolRegistrationId]: { pending: false, error: null } }));
        void refresh();
      } catch (error) {
        const message = toOperationError(error).message;
        setMutations((prev) => ({ ...prev, [row.mcpToolRegistrationId]: { pending: false, error: message } }));
      }
    },
    [refresh],
  );

  const onToggleGrant = useCallback(
    (row: McpToolGrant, granted: boolean) =>
      withMutation(row, () => operations.setMcpToolGrant({ projectItemId, mcpToolRegistrationId: row.mcpToolRegistrationId, granted }).then(() => undefined)),
    [operations, projectItemId, withMutation],
  );

  const onReclassify = useCallback(
    (row: McpToolGrant, patch: { riskClass?: string; requiresApproval?: boolean }) =>
      withMutation(row, () => operations.reclassifyMcpTool({ mcpToolRegistrationId: row.mcpToolRegistrationId, ...patch }).then(() => undefined)),
    [operations, withMutation],
  );

  if (resource.status === "loading") return <LoadingState />;
  if (resource.status === "failed") return <ErrorState error={resource.error} onRetry={reload} />;

  const { rows, refreshing } = resource;
  if (rows.length === 0) return <EmptyState message={t("agentPage.tools.empty")} />;

  const serverIds = [...new Set(rows.map((row) => row.mcpServerItemId))];

  return (
    <section className="agent-tools">
      <h2>{t("agentPage.tools.title")}</h2>
      {refreshing ? (
        <p className="agent-tools__refreshing" role="status" aria-live="polite">
          {t("agentPage.tools.refreshing")}
        </p>
      ) : null}
      {serverIds.map((serverId) => {
        const serverRows = rows.filter((row) => row.mcpServerItemId === serverId);
        const online = serverRows[0]?.mcpServerOnline ?? true;
        return (
          <div className="agent-tools__server" key={serverId}>
            <h3>
              {serverRows[0]?.mcpServerName}
              <ServerOnlineBadge online={online} />
            </h3>
            <ul className="agent-tools__list">
              {serverRows.map((row) => (
                <ToolRow
                  key={row.mcpToolRegistrationId}
                  row={row}
                  mutation={mutations[row.mcpToolRegistrationId]}
                  onToggleGrant={onToggleGrant}
                  onReclassify={onReclassify}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
