import CoreKit
@_exported import FactoryKit

/// Dependencies of one app scene. Every scene creates its own container, so nothing it creates is shared
/// between scenes.
public final class SceneContainer: ManagedContainer {

    // MARK: - Properties
    public let manager = ContainerManager()

    // MARK: - Init
    public init() {}
}

// MARK: - Screen models
extension SceneContainer {

    /// Creates the scene's screen models from one Kotlin SDK. Factory's registration closures are not isolated to
    /// the main actor (Tuist builds the package in Swift 5 mode), so the registration returns a function that the
    /// main actor calls to create the main-actor factory.
    public var screenModelFactory: Factory<@MainActor () -> any ScreenModelFactory> {
        self { { SharedScreenModelFactory() } }
    }
}
