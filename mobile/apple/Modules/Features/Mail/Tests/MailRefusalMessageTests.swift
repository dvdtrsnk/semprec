import CoreKit
import XCTest

@testable import MailFeature

final class MailRefusalMessageTests: XCTestCase {

    func testEveryRefusalHasItsOwnText() {
        let messages = MailRefusal.allCases.map(\.message)
        for (refusal, message) in zip(MailRefusal.allCases, messages) {
            XCTAssertFalse(message.isEmpty, "\(refusal)")
            XCTAssertFalse(message.hasPrefix("mail.refusal."), "\(refusal) has no catalog entry")
        }
        XCTAssertEqual(Set(messages).count, messages.count)
    }

    func testARefusalIsSaidInsteadOfTheFailureItStandsFor() {
        let drafts = MailRefusal.draftsFolderMissing.message
        XCTAssertEqual(FailureKind.message(for: .rejected, refusal: .draftsFolderMissing), drafts)
        XCTAssertEqual(FailureKind.sendMessage(for: .rejected, refusal: .draftsFolderMissing), drafts)
        XCTAssertNotEqual(FailureKind.sendMessage(for: .rejected), drafts)
        XCTAssertEqual(
            FailureKind.message(for: .rejected),
            String(localized: "failure.rejected", bundle: .module)
        )
    }

    func testAnActionAlertWithoutARefusalKeepsTheGenericText() {
        XCTAssertEqual(MailRefusal.actionMessage(for: nil), String(localized: "mail.failure.message", bundle: .module))
        XCTAssertEqual(
            MailRefusal.actionMessage(for: .noReceivedMessage),
            MailRefusal.noReceivedMessage.message
        )
    }
}
