@testable import CoreKit

/// The real screen models over a session kept in memory: a test starts signed out whatever session a build of the app
/// stored in the Keychain of the same simulator.
@MainActor
func isolatedFactory() -> SharedScreenModelFactory {
    SharedScreenModelFactory(sessionStore: .memory)
}
