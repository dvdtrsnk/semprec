@preconcurrency internal import SharedSDK

// MARK: - Service status
extension InternetServiceStatus {

    init(_ status: SharedSDK.InternetServiceStatus) {
        switch status {
        case .off: self = .off
        case .pending: self = .pending
        case .syncing: self = .syncing
        case .ok: self = .ok
        case .error: self = .error
        case .needsReauthorization: self = .needsReauthorization
        case .needsConsent: self = .needsConsent
        }
    }
}

// MARK: - Service
extension InternetAccountService {

    init(_ service: SharedSDK.InternetAccountService) {
        switch service {
        case .mail: self = .mail
        case .calendars: self = .calendars
        }
    }

    var shared: SharedSDK.InternetAccountService {
        switch self {
        case .mail: .mail
        case .calendars: .calendars
        }
    }
}
