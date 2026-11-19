import CoreKit
import Foundation

/// The choices the new item form offers and how it names them: the repeats of an event and of a task, the alert and
/// travel presets, and the words for a number of minutes.
enum NewItemOptions {

    // MARK: - Constants
    /// An event repeats at most monthly; the server builds no yearly rule for it.
    static let eventRepeats: [NewItemRepeat] = [.never, .daily, .weekdays, .weekly, .monthly]
    static let taskRepeats: [NewItemRepeat] = NewItemRepeat.allCases

    /// Alerts of a timed event, minutes before its start.
    static let timedAlerts = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10_080]
    /// Alerts of an all-day event, minutes before nine in the morning of its day.
    static let allDayAlerts = [0, 1440, 2880, 10_080]
    static let travels = [5, 15, 30, 60, 90, 120]

    /// The ranges the server accepts for a custom value.
    static let alertRange = 0...40_320
    static let travelRange = 1...1_440

    // MARK: - Names
    static func name(of repeatRule: NewItemRepeat) -> String {
        let key: String.LocalizationValue = switch repeatRule {
        case .never: "newItem.repeat.never"
        case .daily: "newItem.repeat.daily"
        case .weekdays: "newItem.repeat.weekdays"
        case .weekly: "newItem.repeat.weekly"
        case .monthly: "newItem.repeat.monthly"
        case .yearly: "newItem.repeat.yearly"
        }
        return String(localized: key, table: "Sheets", bundle: .module)
    }

    /// `None`, `At time of event` (`On day of event (9:00)` all day) or `15 minutes before`.
    static func alertName(_ minutes: Int?, allDay: Bool) -> String {
        guard let minutes else { return String(localized: "newItem.none", table: "Sheets", bundle: .module) }
        if minutes == 0 {
            let key: String.LocalizationValue = allDay ? "newItem.alert.onDay" : "newItem.alert.atTime"
            return String(localized: key, table: "Sheets", bundle: .module)
        }
        let format = String(localized: "newItem.alert.before", table: "Sheets", bundle: .module)
        return String(format: format, locale: .current, duration(minutes))
    }

    /// `None` or `1 hour, 30 minutes`.
    static func travelName(_ minutes: Int?) -> String {
        guard let minutes else { return String(localized: "newItem.none", table: "Sheets", bundle: .module) }
        return duration(minutes)
    }

    /// `1 day, 2 hours`, in the person's language.
    static func duration(_ minutes: Int) -> String {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.day, .hour, .minute]
        formatter.unitsStyle = .full
        var calendar = Calendar.current
        calendar.locale = .current
        formatter.calendar = calendar
        return formatter.string(from: TimeInterval(minutes * 60)) ?? "\(minutes)"
    }
}
