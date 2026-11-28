import CoreKit
import Foundation

// MARK: - Tag colour
extension CalendarSwatch {

    /// The localized name of the colour a tag can take, `Zelená`; a key the feature does not know shows its hex value.
    var tagColorName: String {
        switch key {
        case "red": String(localized: "project.tag.color.red", bundle: .module)
        case "orange": String(localized: "project.tag.color.orange", bundle: .module)
        case "yellow": String(localized: "project.tag.color.yellow", bundle: .module)
        case "green": String(localized: "project.tag.color.green", bundle: .module)
        case "teal": String(localized: "project.tag.color.teal", bundle: .module)
        case "blue": String(localized: "project.tag.color.blue", bundle: .module)
        case "indigo": String(localized: "project.tag.color.indigo", bundle: .module)
        case "purple": String(localized: "project.tag.color.purple", bundle: .module)
        case "pink": String(localized: "project.tag.color.pink", bundle: .module)
        case "brown": String(localized: "project.tag.color.brown", bundle: .module)
        case "gray": String(localized: "project.tag.color.gray", bundle: .module)
        default: hex
        }
    }

    /// Whether the swatch is the colour `hex`, whatever its case; a tag without a colour matches none.
    func isTagColor(_ hex: String?) -> Bool {
        guard let hex else { return false }
        return self.hex.caseInsensitiveCompare(hex) == .orderedSame
    }
}
