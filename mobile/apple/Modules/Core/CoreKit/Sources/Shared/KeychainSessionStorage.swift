import Foundation
import Security
@preconcurrency internal import SharedSDK

/// The shared layer's `SessionStorage` in the Keychain: the server a person signed in to and the bearer token of this
/// device. The token is stored nowhere else. When the Keychain refuses an item (an unsigned build has no keychain
/// entitlement), the session lives in memory until the process ends instead of failing the sign-in.
final class KeychainSessionStorage: NSObject, SharedSDK.SessionStorage, @unchecked Sendable {

    // MARK: - Properties
    private let service: String
    private let lock = NSLock()
    private var memory: SharedSDK.StoredSession?

    // MARK: - Init
    init(service: String = "cz.alldots.session") {
        self.service = service
    }

    // MARK: - Protocol conformance
    func load() -> SharedSDK.StoredSession? {
        lock.lock()
        defer { lock.unlock() }
        if let stored = readItem() { return stored }
        return memory
    }

    func save(session: SharedSDK.StoredSession?) {
        lock.lock()
        defer { lock.unlock() }
        deleteItem()
        memory = nil
        guard let session else { return }
        if !writeItem(session) { memory = session }
    }
}

// MARK: - Keychain
private extension KeychainSessionStorage {

    struct Payload: Codable {
        let serverUrl: String
        let token: String
    }

    var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "current"
        ]
    }

    func readItem() -> SharedSDK.StoredSession? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let payload = try? JSONDecoder().decode(Payload.self, from: data)
        else { return nil }
        return SharedSDK.StoredSession(serverUrl: payload.serverUrl, token: payload.token)
    }

    func writeItem(_ session: SharedSDK.StoredSession) -> Bool {
        guard let data = try? JSONEncoder().encode(Payload(serverUrl: session.serverUrl, token: session.token)) else {
            return false
        }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    func deleteItem() {
        SecItemDelete(query as CFDictionary)
    }
}
