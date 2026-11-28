import CoreKit

// MARK: - Days
extension JournalWeek {

    /// Whether `day` (`YYYY-MM-DD`) is one of the week's days; days in this form order as text.
    func contains(day: String) -> Bool {
        firstDay <= day && day <= lastDay
    }
}
