import Foundation

/// The custom keys of a notification's user info.
public enum NotificationPayload {

    /// The keys with string values; the `aps` dictionary and other values are left out.
    public static func strings(of userInfo: [AnyHashable: Any]) -> [String: String] {
        var payload: [String: String] = [:]
        for (key, value) in userInfo {
            if let key = key as? String, let value = value as? String { payload[key] = value }
        }
        return payload
    }
}
