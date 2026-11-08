import CoreKit
import Foundation

// MARK: - Title
extension PlaceholderItem {

    /// The localized title, numbered by the item's ordinal.
    var title: String {
        String(format: String(localized: "home.item.title", bundle: .module), locale: .current, ordinal)
    }
}
