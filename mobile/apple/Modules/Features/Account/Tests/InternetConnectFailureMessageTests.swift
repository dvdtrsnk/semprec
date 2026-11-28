import CoreKit
import XCTest

@testable import AccountFeature

final class InternetConnectFailureMessageTests: XCTestCase {

    private let failures: [InternetConnectFailure] = [
        .invalidInput, .refused, .unavailable, .unexpected, .declined, .wrongCredentials, .appPasswordRequired,
        .serverUnreachable, .tlsFailed, .caldavRefused, .caldavUnreachable, .alreadyConnected, .rateLimited,
        .wrongAccount, .mailConsentMissing
    ]

    func testEveryFailureHasItsOwnText() {
        let messages = failures.map(\.message)
        for (failure, message) in zip(failures, messages) {
            XCTAssertFalse(message.isEmpty, "\(failure)")
            XCTAssertFalse(message.hasPrefix("internetAccounts.add.error."), "\(failure) has no catalog entry")
        }
        XCTAssertEqual(Set(messages).count, messages.count)
    }
}
