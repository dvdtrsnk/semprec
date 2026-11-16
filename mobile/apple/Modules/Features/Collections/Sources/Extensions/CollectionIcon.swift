import Foundation

/// The SF Symbol of an icon name a database declares (lowercase kebab-case); an unknown name gets a generic one.
enum CollectionIcon {

    // MARK: - Properties
    private static let symbols: [String: String] = [
        "folder": "folder",
        "checkmark-circle": "checkmark.circle",
        "person": "person",
        "document": "doc",
        "calendar": "calendar",
        "heart": "heart",
        "building": "building.2",
        "waveform": "waveform",
        "book": "book",
        "compass": "safari",
        "mail": "envelope",
        "tray": "tray",
        "film": "film",
        "moon": "moon",
        "fork-knife": "fork.knife"
    ]

    // MARK: - Methods
    static func symbol(for name: String?) -> String {
        name.flatMap { symbols[$0] } ?? "square.grid.2x2"
    }

    /// The SF Symbol of a database by its canonical key, for places that have no icon name at hand.
    static func symbol(forDatabase key: String?) -> String {
        switch key {
        case "projects": "folder"
        case "tasks": "checkmark.circle"
        case "events": "calendar"
        case "people": "person"
        case "companies": "building.2"
        case "files": "doc"
        case "journal": "book"
        case "threads": "envelope"
        case "transcripts": "waveform"
        case "areas": "safari"
        default: "square.grid.2x2"
        }
    }
}
