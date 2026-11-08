import Foundation

/// One placeholder item of the Home and Detail screens. Native code renders its title from `ordinal`.
public struct PlaceholderItem: Equatable, Hashable, Sendable, Identifiable {

    // MARK: - Properties
    public let id: String
    public let ordinal: Int

    // MARK: - Init
    public init(id: String, ordinal: Int) {
        self.id = id
        self.ordinal = ordinal
    }
}
