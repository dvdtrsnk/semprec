import Foundation

/// Creates one new screen model per call. The caller (a screen's ViewModel) owns the result; releasing
/// it closes the shared ViewModel behind it.
@MainActor
public protocol ScreenModelFactory: AnyObject, Sendable {

    func makeHome() -> any HomeScreenModel
    func makeDetail(itemId: String) -> any DetailScreenModel
    func makeSettings() -> any SettingsScreenModel
    func makeSession() -> any SessionScreenModel
    func makeLogin() -> any LoginScreenModel

    // Journal slice
    /// `initialDay` is the device's current day, `YYYY-MM-DD`; the server's answer names today.
    func makeJournal(initialDay: String) -> any JournalScreenModel
    func makeJournalSubpage(itemId: String) -> any JournalSubpageScreenModel

    /// The sleep sheet for the evening `night` (`YYYY-MM-DD`, or nil); `startOnNight` opens it on that night.
    func makeSleep(night: String?, startOnNight: Bool) -> any SleepScreenModel

    // Calendar slice
    /// `initialDay` is the device's current day, `YYYY-MM-DD`; the server's answer names today.
    func makeCalendar(initialDay: String) -> any CalendarScreenModel
    func makeCalendarList() -> any CalendarListScreenModel
    func makeInvitations() -> any InvitationsScreenModel
    /// `day` is the day the new item sheet was opened for, `YYYY-MM-DD`.
    func makeNewItem(day: String) -> any NewItemScreenModel
}
