import AppIntents
import CoreKit

/// The Inbox types the system offers for `AddToInboxIntent`: "No type" first, then the types the app knows, read from
/// the server or, without a connection, from what the device kept. When they cannot be read it offers only "No type".
struct InboxTypeQuery: EntityQuery {

    // MARK: - Methods
    func entities(for identifiers: [InboxTypeEntity.ID]) async throws -> [InboxTypeEntity] {
        await Self.offered().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [InboxTypeEntity] {
        await Self.offered()
    }

    // MARK: - Private
    @MainActor
    private static func offered() async -> [InboxTypeEntity] {
        switch await InboxShortcutCapture.shared.types() {
        case .loaded(let types): [InboxTypeEntity.noType] + types.map(InboxTypeEntity.init)
        case .failed: [InboxTypeEntity.noType]
        }
    }
}
