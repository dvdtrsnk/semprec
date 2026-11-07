/**
 * The process that owns the Journal `events` relation (issue #1609): the event-link sync derives it from the event
 * links in an entry's page (#2016). No user, agent or MCP write may set it.
 */
export const JOURNAL_EVENT_LINKS_OWNER_PROCESS = "journalEventLinks";
