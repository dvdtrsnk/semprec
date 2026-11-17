@preconcurrency internal import SharedSDK

// MARK: - Shared failures
extension FailureKind {

    init(_ kind: SharedSDK.FailureKind) {
        switch kind {
        case .unavailable: self = .unavailable
        case .invalidData: self = .invalidData
        case .unauthorized: self = .unauthorized
        case .notFound: self = .notFound
        case .rejected: self = .rejected
        }
    }
}
