/// Accessibility identifiers of the Journal feature's elements. The diary is Apple-only for now, so no Android test
/// tag mirrors them.
enum JournalIdentifiers {

    static let screen = "journal.screen"
    static let subpageScreen = "journal.subpage.screen"
    static let today = "journal.today"
    /// Followed by the start day of the period, e.g. `journal.axis.day.2026-10-16`.
    static let axisCellPrefix = "journal.axis."
    /// Followed by the ISO week number.
    static let weekTogglePrefix = "journal.week.toggle."
    /// Followed by the event id.
    static let eventPrefix = "journal.event."
    static let inboxProcess = "journal.inbox.process"
    static let problem = "journal.problem"
    static let problemReload = "journal.problem.reload"
    static let problemDismiss = "journal.problem.dismiss"
    /// Followed by the block index inside the page that names it, e.g. `journal.block.day.2026-10-16.0`.
    static let blockPrefix = "journal.block."
    static let newBlockField = "journal.newBlock.field"
    static let newBlockAdd = "journal.newBlock.add"
}
