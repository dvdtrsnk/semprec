import { useCallback, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "../../components/StateViews.js";
import "./approvalQueue.css";
import { useTranslate } from "../../i18n/index.js";
import { toOperationError } from "../../api/genericOperations.js";
import { useAsyncResource } from "../mailbox/useAsyncResource.js";
import type {
  ApprovalDecision,
  ApprovalQueueEntry,
  ApprovalQueueOperations,
  ApprovalRequestRow,
  DecidedApprovalRequest,
} from "../../api/approvalQueueOperations.js";

interface RowMutationState {
  pending: boolean;
  error: string | null;
}

function formatRequestedAt(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

function MalformedRow({ id }: { id: string | null }) {
  const t = useTranslate();
  return (
    <li className="approval-queue__row approval-queue__row--malformed" role="alert">
      {t("approvalQueue.malformed")}
      {id ? <span className="approval-queue__id"> ({id})</span> : null}
    </li>
  );
}

function DecidedBadge({
  decided,
  requestedDecision,
}: {
  decided: DecidedApprovalRequest;
  requestedDecision: ApprovalDecision;
}) {
  const t = useTranslate();
  // A race: this row was already approved/rejected by someone else before this client's own
  // decision landed — the response carries the *authoritative* outcome, which may not match
  // what this client asked for. Surfacing that explicitly is what turns the zero-row UPDATE
  // into an understood outcome instead of a silent inconsistency.
  const raced = decided.status !== requestedDecision;
  const statusKey = decided.status === "approved" ? "approvalQueue.decided.approved" : "approvalQueue.decided.rejected";
  return (
    <li className="approval-queue__row approval-queue__decided" role="status">
      <p>
        {t(statusKey)}
        {decided.decidedBy ? ` ${t("approvalQueue.decided.by", { user: decided.decidedBy })}` : ""}
      </p>
      {raced ? <p className="approval-queue__race-note">{t("approvalQueue.decided.race")}</p> : null}
    </li>
  );
}

function PendingRow({
  row,
  mutation,
  onDecide,
}: {
  row: ApprovalRequestRow;
  mutation: RowMutationState | undefined;
  onDecide: (row: ApprovalRequestRow, decision: ApprovalDecision) => void;
}) {
  const t = useTranslate();
  const pending = mutation?.pending ?? false;
  const argsSummary =
    row.safeSummary.argKeys.length > 0
      ? t("approvalQueue.row.args", { argKeys: row.safeSummary.argKeys.join(", ") })
      : t("approvalQueue.row.args.none");

  return (
    <li className="approval-queue__row">
      <div className="approval-queue__summary">
        <span className="approval-queue__tool-name">{row.toolName}</span>
        <span className="approval-queue__risk-class">
          {t("approvalQueue.row.riskClass", { riskClass: row.riskClass })}
        </span>
      </div>
      <p className="approval-queue__args">{argsSummary}</p>
      <p className="approval-queue__meta">
        {t("approvalQueue.row.requestedAt", { when: formatRequestedAt(row.requestedAt) })}
      </p>
      <p className="approval-queue__source">
        {row.projectName ??
          (row.projectItemId ? t("approvalQueue.row.project.unknown") : t("approvalQueue.row.project.none"))}
        {" · "}
        <a href={`?page=agent-run&id=${encodeURIComponent(row.agentRunId)}`}>
          {t("approvalQueue.row.agentRun", { id: row.agentRunId })}
        </a>
      </p>
      <div className="approval-queue__actions">
        <button type="button" disabled={pending} onClick={() => onDecide(row, "approved")}>
          {pending ? t("approvalQueue.actions.pending") : t("approvalQueue.actions.approve")}
        </button>
        <button type="button" disabled={pending} onClick={() => onDecide(row, "rejected")}>
          {pending ? t("approvalQueue.actions.pending") : t("approvalQueue.actions.reject")}
        </button>
      </div>
      {mutation?.error ? (
        <p className="approval-queue__row-error" role="alert">
          {t("approvalQueue.actionError", { message: mutation.error })}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Semprec's single global approval queue (issue #132): every still-pending approval request
 * across every project, in one list, with explicit Approve/Reject actions. A decided row (this
 * client's own action, or another actor's — a race on the same request) is rendered with the
 * authoritative decided state (`DecidedBadge`) instead of being silently removed or treated as
 * an error, satisfying the "zero-row transition is not an error" requirement. A row that fails
 * to validate (`ApprovalQueueEntry.kind === "malformed"`) degrades to a placeholder for that row
 * alone rather than failing the whole list.
 */
export function ApprovalQueue({
  operations,
  decidedByUserId,
}: {
  operations: ApprovalQueueOperations;
  decidedByUserId: string;
}) {
  const t = useTranslate();
  const { resource, reload } = useAsyncResource(() => operations.listApprovalRequests(), [operations]);
  const [mutations, setMutations] = useState<Record<string, RowMutationState>>({});
  const [decisions, setDecisions] = useState<
    Record<string, { decided: DecidedApprovalRequest; requestedDecision: ApprovalDecision }>
  >({});

  const onDecide = useCallback(
    async (row: ApprovalRequestRow, decision: ApprovalDecision) => {
      setMutations((prev) => ({ ...prev, [row.id]: { pending: true, error: null } }));
      try {
        const decided = await operations.decideApprovalRequest({
          approvalRequestId: row.id,
          decision,
          decidedByUserId,
        });
        setMutations((prev) => ({ ...prev, [row.id]: { pending: false, error: null } }));
        setDecisions((prev) => ({ ...prev, [row.id]: { decided, requestedDecision: decision } }));
      } catch (error) {
        const message = toOperationError(error).message;
        setMutations((prev) => ({ ...prev, [row.id]: { pending: false, error: message } }));
      }
    },
    [operations, decidedByUserId],
  );

  if (resource.status === "loading") return <LoadingState />;
  if (resource.status === "failed") return <ErrorState error={resource.error} onRetry={reload} />;

  const entries: ApprovalQueueEntry[] = resource.value;
  if (entries.length === 0) return <EmptyState message={t("approvalQueue.empty")} />;

  return (
    <section className="approval-queue">
      <h1>{t("approvalQueue.title")}</h1>
      <ul className="approval-queue__list">
        {entries.map((entry) => {
          if (entry.kind === "malformed") return <MalformedRow key={entry.row.id ?? Math.random()} id={entry.row.id} />;
          const decision = decisions[entry.row.id];
          if (decision) {
            return (
              <DecidedBadge
                key={entry.row.id}
                decided={decision.decided}
                requestedDecision={decision.requestedDecision}
              />
            );
          }
          return (
            <PendingRow key={entry.row.id} row={entry.row} mutation={mutations[entry.row.id]} onDecide={onDecide} />
          );
        })}
      </ul>
    </section>
  );
}
