import Foundation
@preconcurrency internal import SharedSDK

/// The shared layer's `PushSubscriptionStorage` in the user defaults: the id of this device's push subscription, which
/// signing out revokes. The id is no secret; the server only accepts it with the session that owns it.
final class DefaultsPushSubscriptionStorage: NSObject, SharedSDK.PushSubscriptionStorage, @unchecked Sendable {

    // MARK: - Properties
    private let defaults: UserDefaults
    private let key: String

    // MARK: - Init
    init(defaults: UserDefaults = .standard, key: String = "cz.semprec.pushSubscriptionId") {
        self.defaults = defaults
        self.key = key
    }

    // MARK: - Protocol conformance
    func load() -> String? {
        defaults.string(forKey: key)
    }

    func save(subscriptionId: String?) {
        if let subscriptionId {
            defaults.set(subscriptionId, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}
