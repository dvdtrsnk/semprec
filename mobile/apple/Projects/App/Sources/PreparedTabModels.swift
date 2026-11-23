import CoreKit
import Foundation

/// The screen models of the Calendar and the Journal tab, made ahead of the tabs: a tab's content is built only when
/// the person first opens it, and a model made then would start reading only then. Made shortly after the app opens,
/// a model has read its period by the time the tab opens, which then shows it at once. Each model is made for one
/// day and handed out once, to the tab that asks for that day; a model asked for another day (the day changed
/// meanwhile) is dropped, which closes it, and a new one is made.
@MainActor
final class PreparedTabModels {

    // MARK: - Dependencies
    private let models: any ScreenModelFactory

    // MARK: - State
    private var calendar: (day: String, model: any CalendarScreenModel)?
    private var journal: (day: String, model: any JournalScreenModel)?

    // MARK: - Init
    init(models: any ScreenModelFactory) {
        self.models = models
    }

    // MARK: - Methods
    /// Makes the models of the tabs not opened yet for `today` (`YYYY-MM-DD`).
    func prepare(today: String) {
        if calendar == nil { calendar = (today, models.makeCalendar(initialDay: today)) }
        if journal == nil { journal = (today, models.makeJournal(initialDay: today)) }
    }

    /// The calendar's model for `day`: the one made ahead when it was made for that day, otherwise a new one.
    func calendarModel(initialDay day: String) -> any CalendarScreenModel {
        defer { calendar = nil }
        if let calendar, calendar.day == day { return calendar.model }
        return models.makeCalendar(initialDay: day)
    }

    /// The diary's model for `day`: the one made ahead when it was made for that day, otherwise a new one.
    func journalModel(initialDay day: String) -> any JournalScreenModel {
        defer { journal = nil }
        if let journal, journal.day == day { return journal.model }
        return models.makeJournal(initialDay: day)
    }
}
