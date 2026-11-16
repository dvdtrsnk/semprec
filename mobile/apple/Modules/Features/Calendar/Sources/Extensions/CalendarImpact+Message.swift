import CoreKit
import Foundation

// MARK: - Message
extension CalendarImpact {

    /// What deleting the calendar takes with it: nothing, its events, or its events and the cancellations sent to the
    /// people invited to them.
    var message: String {
        if eventCount == 0 {
            return String(localized: "calendars.delete.empty", table: "Sheets", bundle: .module)
        }
        if cancellationCount == 0 {
            return String(
                format: String(localized: "calendars.delete.events", table: "Sheets", bundle: .module),
                locale: .current,
                eventCount
            )
        }
        return String(
            format: String(localized: "calendars.delete.cancellations", table: "Sheets", bundle: .module),
            locale: .current,
            eventCount,
            recipientCount,
            cancellationCount
        )
    }
}
