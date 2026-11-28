import CoreKit
import Foundation

// MARK: - Copy
extension CalendarRow {

    /// Whether the row's info button opens the sleep plan instead of the calendar's settings.
    var isSleep: Bool {
        systemKey == "sleep"
    }

    /// What fills a calendar Alldots keeps itself, under its name; `nil` for the others.
    var subtitle: String? {
        switch systemKey {
        case "tasks": String(localized: "calendars.sub.tasks", table: "Sheets", bundle: .module)
        case "birthdays": String(localized: "calendars.sub.birthdays", table: "Sheets", bundle: .module)
        case "sleep": String(localized: "calendars.sub.sleep", table: "Sheets", bundle: .module)
        case "holidaysCz": String(localized: "calendars.sub.holidaysCz", table: "Sheets", bundle: .module)
        default: nil
        }
    }

    /// The name the provider gives an account calendar that was renamed here; `nil` when it was not renamed.
    var providerName: String? {
        guard group == .account, let remoteName, remoteName != name else { return nil }
        return String(
            format: String(localized: "calendars.detail.remoteName", table: "Sheets", bundle: .module),
            locale: .current,
            remoteName
        )
    }

    /// The hint under the notifications switch of the detail page.
    var hint: String {
        switch (systemKey, group) {
        case ("tasks", _): String(localized: "calendars.detail.hint.tasks", table: "Sheets", bundle: .module)
        case ("birthdays", _): String(localized: "calendars.detail.hint.birthdays", table: "Sheets", bundle: .module)
        case (_, .subscription):
            String(localized: "calendars.detail.hint.subscription", table: "Sheets", bundle: .module)
        case (_, .account) where readOnly:
            String(localized: "calendars.detail.hint.accountReadOnly", table: "Sheets", bundle: .module)
        case (_, .account): String(localized: "calendars.detail.hint.account", table: "Sheets", bundle: .module)
        default: String(localized: "calendars.detail.hint.default", table: "Sheets", bundle: .module)
        }
    }
}
