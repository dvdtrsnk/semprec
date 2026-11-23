/// Accessibility identifiers of the Journal feature's elements. The diary is Apple-only for now, so no Android test
/// tag mirrors them.
enum JournalIdentifiers {

    static let screen = "journal.screen"
    static let today = "journal.today"
    /// Followed by the start day of the period, e.g. `journal.axis.day.2026-10-16`.
    static let axisCellPrefix = "journal.axis."
    /// Followed by the ISO week number.
    static let weekTogglePrefix = "journal.week.toggle."
    /// Followed by the quarter's number, 1 to 4.
    static let quarterTogglePrefix = "journal.quarter.toggle."
    /// Followed by the event id.
    static let eventPrefix = "journal.event."
    static let inboxProcess = "journal.inbox.process"
    static let captureText = "journal.capture.text"
    static let captureSend = "journal.capture.send"
    static let captureType = "journal.capture.type"
    static let captureAttach = "journal.capture.attach"
    static let captureRemove = "journal.capture.remove"
}
