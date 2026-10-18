import { useTranslate } from "../../i18n/index.js";
import type { AdminOperations } from "../../api/adminOperations.js";
import { AccountsPanel } from "./AccountsPanel.js";
import { InvitesPanel } from "./InvitesPanel.js";

/**
 * The admin page (issue #1079): a heading over the panels the admin plane offers. The invitations
 * panel (issue #1080) follows the accounts panel; the budgets and health panels of later issues are
 * added below it.
 */
export function AdminPage({ operations }: { operations: AdminOperations }) {
  const t = useTranslate();
  return (
    <section className="admin-page">
      <h1>{t("admin.title")}</h1>
      <AccountsPanel operations={operations} />
      <InvitesPanel operations={operations} />
    </section>
  );
}
