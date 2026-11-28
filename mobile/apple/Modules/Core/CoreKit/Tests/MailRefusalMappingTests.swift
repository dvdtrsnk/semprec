import SharedSDK
import XCTest

@testable import CoreKit

/// Checks that every reason the server gives for refusing a mail write maps, and that the compose, thread and thread
/// list bridges carry it, with Kotlin values built here.
final class MailRefusalMappingTests: XCTestCase {

    func testEveryRefusalMaps() {
        let refusals: [(SharedSDK.MailRefusal, CoreKit.MailRefusal)] = [
            (.draftsFolderMissing, .draftsFolderMissing), (.sentFolderMissing, .sentFolderMissing),
            (.archiveFolderMissing, .archiveFolderMissing), (.trashFolderMissing, .trashFolderMissing),
            (.inboxFolderMissing, .inboxFolderMissing), (.reauthorizationRequired, .reauthorizationRequired),
            (.mailDisabled, .mailDisabled), (.recipientRejected, .recipientRejected),
            (.loginRejected, .loginRejected), (.serverUnreachable, .serverUnreachable),
            (.attachmentTooLarge, .attachmentTooLarge), (.draftAlreadySent, .draftAlreadySent),
            (.draftNotEditable, .draftNotEditable), (.noReceivedMessage, .noReceivedMessage),
            (.moveSourceUnverified, .moveSourceUnverified), (.alreadyTrashed, .alreadyTrashed),
            (.notArchivedOrTrashed, .notArchivedOrTrashed)
        ]
        XCTAssertEqual(refusals.count, CoreKit.MailRefusal.allCases.count)
        for (kotlin, swift) in refusals {
            XCTAssertEqual(kotlin.refusal, swift)
        }
    }

    @MainActor
    func testTheComposeStateCarriesBothRefusals() {
        let refused = SharedMailComposeScreenModel.state(
            composeState(.error, failure: .rejected, refusal: .draftsFolderMissing, sendRefusal: .sentFolderMissing)
        )
        XCTAssertEqual(refused.phase, .failure(.rejected))
        XCTAssertEqual(refused.refusal, .draftsFolderMissing)
        XCTAssertEqual(refused.sendRefusal, .sentFolderMissing)
        let plain = SharedMailComposeScreenModel.state(composeState(.editing))
        XCTAssertNil(plain.refusal)
        XCTAssertNil(plain.sendRefusal)
    }

    @MainActor
    func testTheThreadStateCarriesTheSendAndActionRefusals() {
        let refused = SharedMailThreadScreenModel.state(
            threadState(.content, sendRefusal: .reauthorizationRequired, actionRefusal: .noReceivedMessage)
        )
        XCTAssertEqual(refused.sendRefusal, .reauthorizationRequired)
        XCTAssertEqual(refused.actionRefusal, .noReceivedMessage)
        XCTAssertNil(SharedMailThreadScreenModel.state(threadState(.content)).actionRefusal)
    }

    @MainActor
    func testTheThreadListStateCarriesTheActionRefusal() {
        let refused = SharedMailThreadsScreenModel.state(threadsState(.content, actionRefusal: .noReceivedMessage))
        XCTAssertEqual(refused.actionRefusal, .noReceivedMessage)
        XCTAssertNil(SharedMailThreadsScreenModel.state(threadsState(.content)).actionRefusal)
    }
}
