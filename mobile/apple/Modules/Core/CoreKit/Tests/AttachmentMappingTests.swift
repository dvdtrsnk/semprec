import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the attachment values the diary and Inbox bridges share, with Kotlin values built here.
final class AttachmentMappingTests: XCTestCase {

    // MARK: - Values
    func testAnAttachmentKeepsItsIdNameAndMediaType() {
        XCTAssertEqual(
            CoreKit.InboxAttachment(SharedSDK.AttachmentState(id: "a1", name: nil, mediaType: "image/jpeg")),
            CoreKit.InboxAttachment(id: "a1", name: nil, mediaType: "image/jpeg")
        )
    }

    func testEveryPreviewPhaseIsMapped() {
        let file = URL(fileURLWithPath: "/cache/inbox-attachments/x/blobs/b1/Scan.pdf")
        let cases: [(SharedSDK.AttachmentPreviewState, CoreKit.AttachmentPreviewPhase)] = [
            (preview(.opening), .opening),
            (preview(.open, path: file.path), .open(file)),
            (preview(.open), .failed(nil)),
            (preview(.failed, failure: .unavailable), .failed(.unavailable)),
            (preview(.failed), .failed(nil))
        ]
        for (kotlin, phase) in cases {
            XCTAssertEqual(AttachmentPreview(kotlin), AttachmentPreview(attachmentId: "a1", phase: phase), "\(phase)")
        }
    }

    func testAPreviewNamesItsFileItsFailureAndWhatIsBeingOpened() {
        let file = URL(fileURLWithPath: "/cache/Scan.pdf")
        let opening = AttachmentPreview(attachmentId: "a1", phase: .opening)
        let open = AttachmentPreview(attachmentId: "a1", phase: .open(file))
        let failed = AttachmentPreview(attachmentId: "a1", phase: .failed(.notFound))

        XCTAssertEqual(opening.openingId, "a1")
        XCTAssertNil(opening.url)
        XCTAssertNil(opening.failure)
        XCTAssertEqual(open.url, file)
        XCTAssertNil(open.openingId)
        XCTAssertNil(open.failure)
        XCTAssertEqual(failed.failure, Failed(kind: .notFound))
        XCTAssertNil(failed.url)
        XCTAssertNil(failed.openingId)
    }

    // MARK: - Inbox
    @MainActor
    func testTheInboxCarriesTheFilesOfACaptureAndTheirPreview() {
        let origin = SharedInboxScreenModel.origin(SharedSDK.InboxOriginState(
            kind: .capture, text: nil, date: nil, time: nil, typeLabel: nil, typeEmoji: nil, name: nil,
            sourceKind: nil, threadTitle: nil, heartbeatName: nil, mcpClientName: nil,
            attachments: [
                SharedSDK.AttachmentState(id: "f1", name: nil, mediaType: "application/pdf"),
                SharedSDK.AttachmentState(id: "f2", name: "scan.png", mediaType: "image/png")
            ]
        ))
        XCTAssertEqual(origin.attachments, [
            CoreKit.InboxAttachment(id: "f1", name: nil, mediaType: "application/pdf"),
            CoreKit.InboxAttachment(id: "f2", name: "scan.png", mediaType: "image/png")
        ])

        let state = SharedSDK.InboxState(
            phase: .content, failure: nil, cards: [], handled: 0, dropped: 0, canUndo: false, refreshing: false,
            busy: false, result: nil, problem: nil, problemFailure: nil, picker: nil,
            attachment: preview(.open, path: "/cache/Invoice.pdf")
        )
        guard case .content(let content) = SharedInboxScreenModel.state(state) else {
            return XCTFail("The state must be content")
        }
        XCTAssertEqual(
            content.attachment,
            AttachmentPreview(attachmentId: "a1", phase: .open(URL(fileURLWithPath: "/cache/Invoice.pdf")))
        )
    }

    @MainActor
    func testTheInboxAttachmentActionsBecomeTheirKotlinActions() throws {
        XCTAssertTrue(SharedInboxScreenModel.action(.closeAttachment) is SharedSDK.InboxActionCloseAttachment)
        let open = try XCTUnwrap(
            SharedInboxScreenModel.action(.openAttachment(cardId: "a", attachmentId: "f1"))
                as? SharedSDK.InboxActionOpenAttachment
        )
        XCTAssertEqual(open.cardId, "a")
        XCTAssertEqual(open.attachmentId, "f1")
    }

    // MARK: - Builders
    private func preview(
        _ phase: SharedSDK.AttachmentPreviewPhase,
        path: String? = nil,
        failure: SharedSDK.FailureKind? = nil
    ) -> SharedSDK.AttachmentPreviewState {
        SharedSDK.AttachmentPreviewState(attachmentId: "a1", phase: phase, path: path, failure: failure)
    }
}
