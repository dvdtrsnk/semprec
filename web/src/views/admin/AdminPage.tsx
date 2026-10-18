import { useTranslate } from "../../i18n/index.js";
import type { AdminOperations } from "../../api/adminOperations.js";
import { AccountsPanel } from "./AccountsPanel.js";

/**
 * The admin page (issue #1079): a heading over the panels the admin plane offers. The invitations,
 * budgets and health panels of later issues are added below the accounts panel.
 */
export function AdminPage({ operations }: { operations: AdminOperations }) {
  const t = useTranslate();
  return (
    <section className="admin-page">
      <h1>{t("admin.title")}</h1>
      <AccountsPanel operations={operations} />
    </section>
  );
}
