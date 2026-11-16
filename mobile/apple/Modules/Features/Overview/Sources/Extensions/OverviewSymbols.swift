import CoreKit
import Foundation

/// The SF Symbols of the overview. The server stores generic icon names (`folder`, `checkmark-circle`, `building`);
/// the symbol of a name it does not know falls back to the symbol of what the row stands for.
enum OverviewSymbols {

    // MARK: - Names
    private static let named: [String: String] = [
        "compass": "safari",
        "folder": "folder",
        "checkmark-circle": "checkmark.circle",
        "person": "person",
        "people": "person.2",
        "document": "doc",
        "calendar": "calendar",
        "heart": "heart",
        "building": "building.2",
        "waveform": "waveform",
        "book": "book",
        "briefcase": "briefcase",
        "home": "house",
        "house": "house",
        "family": "person.2",
        "star": "star"
    ]

    private static let owners: [String: String] = [
        "projects": "folder",
        "tasks": "checkmark.circle",
        "people": "person.2",
        "files": "doc",
        "events": "calendar",
        "healthRecords": "cross.case",
        "companies": "building.2",
        "transcripts": "waveform",
        "journal": "book",
        "areas": "square.grid.2x2",
        "books": "books.vertical",
        "movies": "film",
        "recipes": "fork.knife"
    ]

    static let areaFallback = "square.grid.2x2"
    static let collectionFallback = "square.stack"
    static let projectFallback = "folder"

    // MARK: - Symbols
    /// The symbol of a stored icon name, or nil for a name that is not known.
    static func symbol(forIcon icon: String?) -> String? {
        icon.flatMap { named[$0.lowercased()] }
    }

    static func area(icon: String?) -> String {
        symbol(forIcon: icon) ?? areaFallback
    }

    static func collection(icon: String?, ownerModuleId: String) -> String {
        symbol(forIcon: icon) ?? owners[ownerModuleId] ?? collectionFallback
    }

    /// The symbol of a search group's results.
    static func searchGroup(_ type: SearchGroupType) -> String {
        switch type {
        case .task: "checkmark.circle"
        case .event: "calendar"
        case .project: "folder"
        case .area: "house"
        case .contact: "person"
        case .journal: "book"
        case .file: "doc"
        case .mail: "envelope"
        case .chat: "bubble.left"
        }
    }
}
