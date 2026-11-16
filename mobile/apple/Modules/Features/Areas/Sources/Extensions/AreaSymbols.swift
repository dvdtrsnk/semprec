import Foundation

/// The SF Symbols of an area and of the collections connected to it. The server stores generic icon names
/// (`briefcase`, `heart`, `home`); the symbol of a name it does not know falls back to the symbol of what the row
/// stands for.
enum AreaSymbols {

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
        "star": "star",
        "mail": "envelope",
        "film": "film",
        "fork-knife": "fork.knife"
    ]

    private static let owners: [String: String] = [
        "projects": "folder",
        "tasks": "checkmark.circle",
        "people": "person.2",
        "files": "doc",
        "events": "calendar",
        "threads": "envelope",
        "healthRecords": "cross.case",
        "companies": "building.2",
        "transcripts": "waveform",
        "journal": "book",
        "books": "books.vertical",
        "movies": "film",
        "recipes": "fork.knife"
    ]

    static let areaFallback = "square.grid.2x2"
    static let collectionFallback = "square.stack"

    // MARK: - Symbols
    static func area(icon: String?) -> String {
        icon.flatMap { named[$0.lowercased()] } ?? areaFallback
    }

    static func collection(icon: String?, databaseKey: String?) -> String {
        icon.flatMap { named[$0.lowercased()] } ?? databaseKey.flatMap { owners[$0] } ?? collectionFallback
    }
}
