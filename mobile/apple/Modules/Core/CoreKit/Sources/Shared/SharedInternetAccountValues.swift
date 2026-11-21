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

// MARK: - Connect failure
extension InternetConnectFailure {

    init(_ failure: SharedSDK.InternetConnectFailure) {
        switch failure {
        case .invalidInput: self = .invalidInput
        case .refused: self = .refused
        case .unavailable: self = .unavailable
        case .unexpected: self = .unexpected
        case .declined: self = .declined
        case .wrongCredentials: self = .wrongCredentials
        case .appPasswordRequired: self = .appPasswordRequired
        case .serverUnreachable: self = .serverUnreachable
        case .tlsFailed: self = .tlsFailed
        case .caldavRefused: self = .caldavRefused
        case .caldavUnreachable: self = .caldavUnreachable
        case .alreadyConnected: self = .alreadyConnected
        case .rateLimited: self = .rateLimited
        }
    }
}

// MARK: - Password sign-in
extension InternetPasswordSignIn {

    init(_ signIn: SharedSDK.InternetPasswordSignIn) {
        self.init(
            accountId: signIn.accountId,
            address: signIn.address,
            icloud: signIn.icloud,
            submitting: signIn.submitting,
            failure: signIn.failure.map(InternetConnectFailure.init)
        )
    }
}

// MARK: - Password sign-in step
extension InternetPasswordSignInStep {

    var shared: any SharedSDK.InternetPasswordSignInStep {
        switch self {
        case .submit(let password, let username):
            SharedSDK.InternetPasswordSignInStepSubmit(password: password, username: username)
        case .cancel: SharedSDK.InternetPasswordSignInStepCancel.shared
        }
    }
}
