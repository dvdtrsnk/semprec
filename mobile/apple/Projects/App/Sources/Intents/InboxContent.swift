import AppIntents

/// What `AddToInboxIntent` captures: a text, or on iOS a document scanned with the camera. macOS has no document
/// scanner, so it offers only the text.
enum InboxContent: String, AppEnum {

    case text
    #if os(iOS)
    case scan
    #endif

    // MARK: - Shared
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "intent.inboxContent.name")

    #if os(iOS)
    static let caseDisplayRepresentations: [InboxContent: DisplayRepresentation] = [
        .text: DisplayRepresentation(title: "intent.inboxContent.text", image: .init(systemName: "text.alignleft")),
        .scan: DisplayRepresentation(title: "intent.inboxContent.scan", image: .init(systemName: "doc.viewfinder"))
    ]
    #else
    static let caseDisplayRepresentations: [InboxContent: DisplayRepresentation] = [
        .text: DisplayRepresentation(title: "intent.inboxContent.text", image: .init(systemName: "text.alignleft"))
    ]
    #endif
}
