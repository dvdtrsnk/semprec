import CoreKit
import Foundation

// MARK: - Name
extension CalendarSwatch {

    /// The localized name of the colour, `Červená`; a key the sheet does not know shows its hex value.
    var name: String {
        switch key {
        case "red": String(localized: "calendars.color.red", table: "Sheets", bundle: .module)
        case "orange": String(localized: "calendars.color.orange", table: "Sheets", bundle: .module)
        case "yellow": String(localized: "calendars.color.yellow", table: "Sheets", bundle: .module)
        case "green": String(localized: "calendars.color.green", table: "Sheets", bundle: .module)
        case "teal": String(localized: "calendars.color.teal", table: "Sheets", bundle: .module)
        case "blue": String(localized: "calendars.color.blue", table: "Sheets", bundle: .module)
        case "indigo": String(localized: "calendars.color.indigo", table: "Sheets", bundle: .module)
        case "purple": String(localized: "calendars.color.purple", table: "Sheets", bundle: .module)
        case "pink": String(localized: "calendars.color.pink", table: "Sheets", bundle: .module)
        case "brown": String(localized: "calendars.color.brown", table: "Sheets", bundle: .module)
        case "gray": String(localized: "calendars.color.gray", table: "Sheets", bundle: .module)
        default: hex
        }
    }

    /// Whether the swatch is the colour `hex`, whatever its case.
    func matches(_ hex: String) -> Bool {
        self.hex.caseInsensitiveCompare(hex) == .orderedSame
    }
}
