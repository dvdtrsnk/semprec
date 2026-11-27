import AppIntents
import CoreKit

/// An Inbox item type a capture of `AddToInboxIntent` can have, or "No type", which every list of them offers.
struct InboxTypeEntity: AppEntity {

    // MARK: - Shared
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "intent.inboxType.name")
    static let defaultQuery = InboxTypeQuery()

    /// "No type": its id is no UUID, and the server accepts only UUIDs as type ids, so no type it answers has it.
    static let noType = InboxTypeEntity(id: "noType", label: nil, emoji: "")

    // MARK: - Dependencies
    let id: String
    /// The type's name as the server words it; nil for "No type", whose name comes from the catalog.
    let label: String?
    let emoji: String

    // MARK: - Init
    init(_ type: InboxCaptureType) {
        self.init(id: type.id, label: type.label, emoji: type.emoji)
    }

    private init(id: String, label: String?, emoji: String) {
        self.id = id
        self.label = label
        self.emoji = emoji
    }

    // MARK: - Methods
    /// The type id a capture is kept with: nil for "No type".
    var typeId: String? {
        label == nil ? nil : id
    }

    var displayRepresentation: DisplayRepresentation {
        guard let label else { return DisplayRepresentation(title: "intent.inboxType.none") }
        let name = emoji.isEmpty ? label : "\(emoji) \(label)"
        return DisplayRepresentation(title: "\(name)")
    }
}
