import CoreKit
import XCTest

@testable import MailFeature

final class MailContentMessageTests: XCTestCase {

    func testEveryReasonAProviderFetchFailsHasItsOwnText() {
        let messages = MailContentUnavailable.allCases.map(\.message)
        for (reason, message) in zip(MailContentUnavailable.allCases, messages) {
            XCTAssertFalse(message.isEmpty, "\(reason)")
            XCTAssertFalse(message.hasPrefix("mail.content."), "\(reason) has no catalog entry")
        }
        XCTAssertEqual(Set(messages).count, messages.count)
    }

    func testAReasonIsSaidInsteadOfTheFailureAndWithoutOneTheFailureIs() {
        XCTAssertEqual(
            MailContentUnavailable.message(for: .unavailable, unavailable: .rateLimited),
            MailContentUnavailable.rateLimited.message
        )
        XCTAssertEqual(
            MailContentUnavailable.message(for: .notFound, unavailable: nil),
            FailureKind.message(for: .notFound)
        )
        XCTAssertEqual(
            MailContentUnavailable.message(for: nil, unavailable: nil),
            String(localized: "failure.unexpected", bundle: .module)
        )
    }
}
