import AppIntents
import CoreKit
import DesignSystem

/// What the system offers for the type of `AddToInboxIntent`: "Scan" first where the device can scan a document (never
/// on a Mac), then "No type", then the types the app knows, read from the server or, without a connection, from what
/// the device kept. When the types cannot be read it offers "Scan" and "No type" alone.
struct InboxTypeQuery: EntityQuery {

    // MARK: - Methods
    func entities(for identifiers: [InboxTypeEntity.ID]) async throws -> [InboxTypeEntity] {
        await Self.offered().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [InboxTypeEntity] {
        await Self.offered()
    }

    /// The list for `types` as the bridge answered them, with "Scan" when `scannerSupported`, which is whether this
    /// device can scan unless a test says otherwise.
    static func offered(
        _ types: InboxShortcutCapture.Types,
        scannerSupported: Bool = ScanDocument.isScannerSupported
    ) -> [InboxTypeEntity] {
        let known: [InboxTypeEntity] = switch types {
        case .loaded(let types): types.map(InboxTypeEntity.init)
        case .failed: []
        }
        return (scannerSupported ? [InboxTypeEntity.scan] : []) + [InboxTypeEntity.noType] + known
    }

    // MARK: - Private
    @MainActor
    private static func offered() async -> [InboxTypeEntity] {
        offered(await InboxShortcutCapture.shared.types())
    }
}
