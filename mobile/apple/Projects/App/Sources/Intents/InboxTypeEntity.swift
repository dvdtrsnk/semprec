import AppIntents
import CoreKit

/// What a capture of `AddToInboxIntent` is: an Inbox item type, "No type", which every list of them offers, or "Scan",
/// which the list offers where the device can scan a document and which keeps a scanned PDF without a type.
struct InboxTypeEntity: AppEntity {

    // MARK: - Types
    enum Kind: Equatable, Sendable {
        case scan
        case noType
        /// A type of the server, with its name as the server words it and its emoji (empty for none).
        case type(label: String, emoji: String)
    }

    // MARK: - Shared
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "intent.inboxType.name")
    static let defaultQuery = InboxTypeQuery()

    /// The ids of "Scan" and "No type" are no UUIDs, and the server accepts only UUIDs as type ids, so no type it
    /// answers has one of them.
    static let scan = InboxTypeEntity(id: "scan", kind: .scan)
    static let noType = InboxTypeEntity(id: "noType", kind: .noType)

    // MARK: - Dependencies
    let id: String
    let kind: Kind

    // MARK: - Init
    init(_ type: InboxCaptureType) {
        self.init(id: type.id, kind: .type(label: type.label, emoji: type.emoji))
    }

    private init(id: String, kind: Kind) {
        self.id = id
        self.kind = kind
    }

    // MARK: - Methods
    /// The type id a text capture is kept with: nil for "No type" and for "Scan".
    var typeId: String? {
        guard case .type = kind else { return nil }
        return id
    }

    var displayRepresentation: DisplayRepresentation {
        switch kind {
        case .scan:
            DisplayRepresentation(title: "intent.inboxType.scan", image: .init(systemName: "doc.viewfinder"))
        case .noType:
            DisplayRepresentation(title: "intent.inboxType.none")
        case .type(let label, let emoji):
            DisplayRepresentation(title: "\(emoji.isEmpty ? label : "\(emoji) \(label)")")
        }
    }
}
