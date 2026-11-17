import SharedSDK
import XCTest

@testable import CoreKit

/// Every branch of the capture row's bridge, with the Kotlin values it maps.
@MainActor
final class InboxCaptureMappingTests: XCTestCase {

    func testTheStateMapsItsTypesPickAttachmentAndFailure() {
        let state = SharedSDK.InboxCaptureState(
            types: [SharedSDK.InboxCaptureTypeState(id: "t1", label: "Task", emoji: "T")],
            typesPhase: .ready,
            typeId: "t1",
            attachment: SharedSDK.InboxCaptureAttachmentState(filename: "a.png", mimeType: "image/png", byteSize: 3),
            sending: true,
            failure: SharedSDK.Failed(kind: .rejected)
        )
        XCTAssertEqual(
            SharedInboxCaptureScreenModel.state(state),
            CoreKit.InboxCaptureState(
                types: [CoreKit.InboxCaptureType(id: "t1", label: "Task", emoji: "T")],
                typesPhase: .ready,
                typeId: "t1",
                attachment: CoreKit.InboxCaptureAttachment(filename: "a.png", mimeType: "image/png", byteSize: 3),
                sending: true,
                failure: CoreKit.Failed(kind: .rejected)
            )
        )
        let empty = SharedSDK.InboxCaptureState(
            types: [], typesPhase: .idle, typeId: nil, attachment: nil, sending: false, failure: nil
        )
        XCTAssertEqual(SharedInboxCaptureScreenModel.state(empty), CoreKit.InboxCaptureState())
    }

    func testEveryPhaseMaps() {
        let phases: [(SharedSDK.InboxCapturePhase, CoreKit.InboxCapturePhase)] = [
            (.idle, .idle), (.loading, .loading), (.ready, .ready), (.failed, .failed)
        ]
        for (shared, expected) in phases {
            XCTAssertEqual(SharedInboxCaptureScreenModel.phase(shared), expected)
        }
    }

    func testActionsWithoutArgumentsMapToTheirKotlinObjects() {
        XCTAssertTrue(SharedInboxCaptureScreenModel.action(.loadTypes) is SharedSDK.InboxCaptureActionLoadTypes)
        XCTAssertTrue(
            SharedInboxCaptureScreenModel.action(.removeAttachment) is SharedSDK.InboxCaptureActionRemoveAttachment
        )
        XCTAssertTrue(
            SharedInboxCaptureScreenModel.action(.dismissFailure) is SharedSDK.InboxCaptureActionDismissFailure
        )
    }

    func testActionsCarryTheirArguments() throws {
        let pick = try XCTUnwrap(
            SharedInboxCaptureScreenModel.action(.pickType("t1")) as? SharedSDK.InboxCaptureActionPickType
        )
        XCTAssertEqual(pick.typeId, "t1")
        let none = try XCTUnwrap(
            SharedInboxCaptureScreenModel.action(.pickType(nil)) as? SharedSDK.InboxCaptureActionPickType
        )
        XCTAssertNil(none.typeId)
        let attach = try XCTUnwrap(
            SharedInboxCaptureScreenModel.action(
                .attach(filename: "a.png", mimeType: "image/png", base64: "YWJj", source: .camera)
            ) as? SharedSDK.InboxCaptureActionAttach
        )
        XCTAssertEqual(attach.filename, "a.png")
        XCTAssertEqual(attach.mimeType, "image/png")
        XCTAssertEqual(attach.base64, "YWJj")
        XCTAssertEqual(attach.source, .camera)
        let submit = try XCTUnwrap(
            SharedInboxCaptureScreenModel.action(.submit(text: "Note", day: "2026-11-16", time: "08:15"))
                as? SharedSDK.InboxCaptureActionSubmit
        )
        XCTAssertEqual(submit.text, "Note")
        XCTAssertEqual(submit.day, "2026-11-16")
        XCTAssertEqual(submit.time, "08:15")
    }

    func testEverySourceMaps() {
        XCTAssertEqual(SharedInboxCaptureScreenModel.source(.camera), .camera)
        XCTAssertEqual(SharedInboxCaptureScreenModel.source(.photoLibrary), .photoLibrary)
        XCTAssertEqual(SharedInboxCaptureScreenModel.source(.files), .files)
    }

    func testTheCapturedEffectMaps() {
        XCTAssertEqual(SharedInboxCaptureScreenModel.effect(SharedSDK.InboxCaptureEffectCaptured.shared), .captured)
    }

    func testTheRealViewModelStartsIdleAndClosesWithItsBridge() async throws {
        var model: SharedInboxCaptureScreenModel? = try XCTUnwrap(
            isolatedFactory().makeInboxCapture() as? SharedInboxCaptureScreenModel
        )
        XCTAssertEqual(model?.state, CoreKit.InboxCaptureState())
        let lease = try XCTUnwrap(model?.lease)
        XCTAssertFalse(lease.isClosed)
        model = nil
        XCTAssertTrue(lease.isClosed)
    }
}
