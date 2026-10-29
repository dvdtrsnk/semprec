import type { ModuleManifest } from "@semprec/module-registry";
import { CALENDAR_MODULE_ID } from "./calendarModuleId.js";

/**
 * Manifest of the calendar module. It is registered empty so that the later calendar issues
 * (calendars, invitations, reminders, recurrence, timeline, agent tools) add their databases,
 * routes, heartbeat actions and agent tools to this one manifest. The module will own the
 * calendar databases and the system-owned properties on them (`CALENDAR_MODULE_ID` is their
 * owner process). Like the Inbox and Mail modules it is non-removable and a system project
 * module. Registering it adds no database, route, action or tool and changes no behavior.
 */
export const manifest: ModuleManifest = {
  id: CALENDAR_MODULE_ID,
  version: "1.0.0",
  name: "Calendar",
  removable: false,
  systemProject: true,
  databases: [],
  capabilities: [],
  agentTools: [],
};
