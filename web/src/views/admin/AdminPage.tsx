import { useTranslate } from "../../i18n/index.js";
import type { AdminOperations } from "../../api/adminOperations.js";
import { AccountsPanel } from "./AccountsPanel.js";
import { InvitesPanel } from "./InvitesPanel.js";
import { BudgetsPanel } from "./BudgetsPanel.js";
import { HealthPanel } from "./HealthPanel.js";

/**
 * The admin page (issue #1079): a heading over the panels the admin plane offers. `currentUserId` is the
 * signed-in admin, whose own account the accounts panel never offers to delete. The invitations
 * panel (issue #1080) follows the accounts panel, and the AI budgets panel (issue #1081) follows the
 * invitations, and the operator health panel (issue #1082) follows the budgets.
 */
export function AdminPage({ operations, currentUserId }: { operations: AdminOperations; currentUserId: string }) {
  const t = useTranslate();
  return (
    <section className="admin-page">
      <h1>{t("admin.title")}</h1>
      <AccountsPanel operations={operations} currentUserId={currentUserId} />
      <InvitesPanel operations={operations} />
      <BudgetsPanel operations={operations} />
      <HealthPanel operations={operations} />
    </section>
  );
}
