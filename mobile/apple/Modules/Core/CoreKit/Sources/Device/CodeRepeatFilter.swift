import Foundation

/// Lets a code through when it is not the one read just before or when `interval` has passed since it was let through,
/// so a camera that keeps seeing one code reports it about once per interval instead of once per frame.
struct CodeRepeatFilter: Sendable {

    // MARK: - Properties
    static let interval: TimeInterval = 2
    private var last: (code: String, at: Date)?

    // MARK: - Methods
    mutating func accepts(_ code: String, at date: Date) -> Bool {
        if let last, last.code == code, date.timeIntervalSince(last.at) < Self.interval { return false }
        last = (code, date)
        return true
    }
}
