import { useRef, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "../../components/StateViews.js";
import { useLocale, useTranslate } from "../../i18n/index.js";
import { formatUsd } from "../../i18n/format.js";
import { toOperationError } from "../../api/genericOperations.js";
import type { AdminOperations, AiBudgetAccount, AiBudgetCaps } from "../../api/adminOperations.js";
import { useAsyncResource } from "../mailbox/useAsyncResource.js";

type CapParse = { ok: true; value: number | null } | { ok: false };

/**
 * An empty field means "no cap"; anything else must be a finite number ≥ 0. A `type="number"` input
 * reports an empty value for text it cannot parse (a lone `-`, an incomplete exponent), so `badInput`
 * — the browser's own flag for that text — makes the field invalid rather than uncapped. `Number("")`
 * is 0, so empty is checked first.
 */
function parseCap(text: string, badInput: boolean): CapParse {
  if (badInput) return { ok: false };
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? { ok: true, value } : { ok: false };
}

/**
 * The AI budgets panel on the admin page (issue #1081). Each account shows its daily and monthly
 * caps and its spend over the UTC day and month. An account without a budget row is refused every
 * AI call, so it shows that state instead of caps. Editing is inline and one row at a time: Save
 * validates both fields itself, sends no request when one is invalid, and keeps the typed values
 * when the server refuses the write.
 */
export function BudgetsPanel({ operations }: { operations: AdminOperations }) {
  const t = useTranslate();
  const locale = useLocale();
  const { resource, reload } = useAsyncResource(() => operations.listAiBudgets(), [operations]);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [dailyDraft, setDailyDraft] = useState("");
  const [monthlyDraft, setMonthlyDraft] = useState("");
  const dailyInput = useRef<HTMLInputElement>(null);
  const monthlyInput = useRef<HTMLInputElement>(null);
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function startEdit(account: AiBudgetAccount) {
    setEditingUserId(account.userId);
    setDailyDraft(account.dailyCapUsd === null ? "" : String(account.dailyCapUsd));
    setMonthlyDraft(account.monthlyCapUsd === null ? "" : String(account.monthlyCapUsd));
    setInvalid(false);
    setSaveError(null);
  }

  function cancelEdit() {
    setEditingUserId(null);
    setInvalid(false);
    setSaveError(null);
  }

  async function handleSave(account: AiBudgetAccount) {
    const daily = parseCap(dailyDraft, dailyInput.current?.validity.badInput ?? false);
    const monthly = parseCap(monthlyDraft, monthlyInput.current?.validity.badInput ?? false);
    if (!daily.ok || !monthly.ok) {
      setInvalid(true);
      return;
    }
    const caps: AiBudgetCaps = { dailyCapUsd: daily.value, monthlyCapUsd: monthly.value };
    setSaving(true);
    setInvalid(false);
    setSaveError(null);
    try {
      await operations.setAiBudget(account.userId, caps);
      setEditingUserId(null);
      reload();
    } catch (error) {
      setSaveError(t("admin.budgets.saveFailed", { message: toOperationError(error).message }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="admin-budgets">
      <h2>{t("admin.budgets.title")}</h2>
      <p>{t("admin.budgets.utcNote")}</p>

      {invalid ? (
        <p role="alert" className="admin-budgets__error">
          {t("admin.budgets.invalid")}
        </p>
      ) : null}

      {saveError ? (
        <p role="alert" className="admin-budgets__error">
          {saveError}
        </p>
      ) : null}

      {renderTable()}
    </section>
  );

  function renderTable() {
    if (resource.status === "loading") return <LoadingState />;
    if (resource.status === "failed") return <ErrorState error={resource.error} onRetry={reload} />;

    const accounts = resource.value;
    if (accounts.length === 0) return <EmptyState message={t("admin.budgets.empty")} />;

    return (
      <table>
        <thead>
          <tr>
            <th scope="col">{t("admin.accounts.email")}</th>
            <th scope="col">{t("admin.budgets.dailyCap")}</th>
            <th scope="col">{t("admin.budgets.monthlyCap")}</th>
            <th scope="col">{t("admin.budgets.spentToday")}</th>
            <th scope="col">{t("admin.budgets.spentMonth")}</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.userId}>
              <td>{account.email}</td>
              {editingUserId === account.userId ? (
                renderEditCells()
              ) : (
                <>
                  <td>{renderCap(account, account.dailyCapUsd)}</td>
                  {/* The no-budget message sits in the daily cell alone, so the row states it once. */}
                  <td>{account.hasBudget ? renderCap(account, account.monthlyCapUsd) : null}</td>
                </>
              )}
              <td>{formatUsd(locale, account.spentTodayUsd)}</td>
              <td>{formatUsd(locale, account.spentMonthUsd)}</td>
              <td>{editingUserId === account.userId ? renderEditActions(account) : renderEditButton(account)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  function renderCap(account: AiBudgetAccount, cap: number | null) {
    if (!account.hasBudget) return t("admin.budgets.noBudget");
    if (cap === null) return t("admin.budgets.uncapped");
    return formatUsd(locale, cap);
  }

  function renderEditCells() {
    return (
      <>
        <td>
          <input
            type="number"
            min="0"
            step="0.01"
            aria-label={t("admin.budgets.dailyCap")}
            disabled={saving}
            ref={dailyInput}
            value={dailyDraft}
            onChange={(event) => {
              setDailyDraft(event.target.value);
            }}
          />
        </td>
        <td>
          <input
            type="number"
            min="0"
            step="0.01"
            aria-label={t("admin.budgets.monthlyCap")}
            disabled={saving}
            ref={monthlyInput}
            value={monthlyDraft}
            onChange={(event) => {
              setMonthlyDraft(event.target.value);
            }}
          />
        </td>
      </>
    );
  }

  function renderEditActions(account: AiBudgetAccount) {
    return (
      <>
        <button type="button" disabled={saving} onClick={() => handleSave(account)}>
          {saving ? t("admin.budgets.saving") : t("admin.budgets.save")}
        </button>
        <button type="button" disabled={saving} onClick={cancelEdit}>
          {t("admin.budgets.cancel")}
        </button>
      </>
    );
  }

  function renderEditButton(account: AiBudgetAccount) {
    return (
      <button type="button" disabled={editingUserId !== null} onClick={() => startEdit(account)}>
        {t("admin.budgets.edit")}
      </button>
    );
  }
}
