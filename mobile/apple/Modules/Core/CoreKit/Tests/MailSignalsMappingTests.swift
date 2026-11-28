import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the mail signals bridge's mappings between Kotlin and Swift values with Kotlin values built
/// here. Both modules declare most of these type names, so each is qualified with its module.
final class MailSignalsMappingTests: XCTestCase {

    // MARK: - State
    @MainActor
    func testEveryPhaseMaps() {
        let phases: [(SharedSDK.ProjectMailSignalsPhase, CoreKit.ProjectMailSignalsPhase)] = [
            (.loading, .loading), (.ready, .ready), (.error, .error)
        ]
        for (shared, expected) in phases {
            XCTAssertEqual(SharedProjectMailSignalsScreenModel.state(signalsState(phase: shared)).phase, expected)
        }
        let previewPhases: [(SharedSDK.MailSignalsPreviewPhase, CoreKit.MailSignalsPreviewPhase)] = [
            (.loading, .loading), (.ready, .ready), (.error, .error)
        ]
        for (shared, expected) in previewPhases {
            XCTAssertEqual(SharedProjectMailSignalsScreenModel.preview(previewState(phase: shared)).phase, expected)
        }
    }

    @MainActor
    func testEveryFieldMapsBothWays() {
        let fields: [(SharedSDK.MailSignalField, CoreKit.MailSignalField)] = [
            (.domains, .domains), (.addresses, .addresses), (.keywords, .keywords)
        ]
        for (shared, native) in fields {
            XCTAssertEqual(SharedProjectMailSignalsScreenModel.field(shared), native)
            XCTAssertEqual(SharedProjectMailSignalsScreenModel.field(native), shared)
        }
    }

    @MainActor
    func testAReadyStateMapsEveryValue() {
        let state = SharedProjectMailSignalsScreenModel.state(
            signalsState(
                phase: .ready,
                invalidField: .addresses,
                saveFailure: SharedSDK.Failed(kind: .rejected),
                preview: previewState(phase: .ready, failure: nil),
                assignFailure: SharedSDK.Failed(kind: nil),
                assignment: SharedSDK.MailSignalsAssignment(assigned: 3, skipped: 1)
            )
        )
        XCTAssertEqual(
            state,
            CoreKit.ProjectMailSignalsState(
                phase: .ready,
                failure: nil,
                people: [CoreKit.MailSignalPersonItem(personId: "u1", name: "Petr Novák", address: "petr@novak.cz")],
                domains: ["novak.cz"],
                addresses: ["jana@pekarna.cz"],
                keywords: ["Faktura"],
                domainInput: "pek",
                addressInput: "jana@",
                keywordInput: "smlou",
                invalidField: .addresses,
                unsaved: true,
                saving: true,
                saveFailure: CoreKit.Failed(kind: .rejected),
                preview: CoreKit.MailSignalsPreviewState(
                    phase: .ready,
                    failure: nil,
                    total: 12,
                    alreadyAssigned: 4,
                    threads: [
                        CoreKit.MailSignalThreadItem(
                            threadId: "t1",
                            subject: "Faktura za březen",
                            senderName: "Petr Novák",
                            senderAddress: "petr@novak.cz",
                            lastMessageAt: "2026-11-19T08:00:00Z"
                        )
                    ]
                ),
                assigning: true,
                assignFailure: CoreKit.Failed(kind: nil),
                assignment: CoreKit.MailSignalsAssignment(assigned: 3, skipped: 1),
                canSave: true,
                canAssign: true
            )
        )
    }

    @MainActor
    func testAFailedStateMapsItsFailuresAndNoneOfTheOptionalValues() {
        let state = SharedProjectMailSignalsScreenModel.state(
            signalsState(phase: .error, failure: .notFound, preview: previewState(phase: .error, failure: .unavailable))
        )
        XCTAssertEqual(state.failure, .notFound)
        XCTAssertEqual(state.preview.failure, .unavailable)
        XCTAssertNil(state.invalidField)
        XCTAssertNil(state.saveFailure)
        XCTAssertNil(state.assignFailure)
        XCTAssertNil(state.assignment)
    }

    // MARK: - Actions
    @MainActor
    func testEveryActionMapsToItsKotlinAction() throws {
        typealias Bridge = SharedProjectMailSignalsScreenModel
        XCTAssertTrue(Bridge.action(.retry) is SharedSDK.ProjectMailSignalsActionRetry)
        XCTAssertTrue(Bridge.action(.save) is SharedSDK.ProjectMailSignalsActionSave)
        XCTAssertTrue(Bridge.action(.assign) is SharedSDK.ProjectMailSignalsActionAssign)
        XCTAssertTrue(Bridge.action(.retryPreview) is SharedSDK.ProjectMailSignalsActionRetryPreview)
        XCTAssertTrue(Bridge.action(.dismissAssignment) is SharedSDK.ProjectMailSignalsActionDismissAssignment)
        XCTAssertTrue(Bridge.action(.dismissFailure) is SharedSDK.ProjectMailSignalsActionDismissFailure)

        let edit = try XCTUnwrap(
            Bridge.action(.editInput(.keywords, text: "faktura")) as? SharedSDK.ProjectMailSignalsActionEditInput
        )
        XCTAssertEqual(edit.field, .keywords)
        XCTAssertEqual(edit.text, "faktura")
        let add = try XCTUnwrap(Bridge.action(.add(.domains)) as? SharedSDK.ProjectMailSignalsActionAdd)
        XCTAssertEqual(add.field, .domains)
        let remove = try XCTUnwrap(
            Bridge.action(.remove(.addresses, value: "jana@pekarna.cz")) as? SharedSDK.ProjectMailSignalsActionRemove
        )
        XCTAssertEqual(remove.field, .addresses)
        XCTAssertEqual(remove.value, "jana@pekarna.cz")
    }
}

// MARK: - Kotlin values
private func previewState(
    phase: SharedSDK.MailSignalsPreviewPhase,
    failure: SharedSDK.FailureKind? = nil
) -> SharedSDK.MailSignalsPreviewState {
    SharedSDK.MailSignalsPreviewState(
        phase: phase,
        failure: failure,
        total: 12,
        alreadyAssigned: 4,
        threads: [
            SharedSDK.MailSignalThreadItem(
                threadId: "t1",
                subject: "Faktura za březen",
                senderName: "Petr Novák",
                senderAddress: "petr@novak.cz",
                lastMessageAt: "2026-11-19T08:00:00Z"
            )
        ]
    )
}

private func signalsState(
    phase: SharedSDK.ProjectMailSignalsPhase,
    failure: SharedSDK.FailureKind? = nil,
    invalidField: SharedSDK.MailSignalField? = nil,
    saveFailure: SharedSDK.Failed? = nil,
    preview: SharedSDK.MailSignalsPreviewState = previewState(phase: .loading),
    assignFailure: SharedSDK.Failed? = nil,
    assignment: SharedSDK.MailSignalsAssignment? = nil
) -> SharedSDK.ProjectMailSignalsState {
    SharedSDK.ProjectMailSignalsState(
        phase: phase,
        failure: failure,
        people: [SharedSDK.MailSignalPersonItem(personId: "u1", name: "Petr Novák", address: "petr@novak.cz")],
        domains: ["novak.cz"],
        addresses: ["jana@pekarna.cz"],
        keywords: ["Faktura"],
        domainInput: "pek",
        addressInput: "jana@",
        keywordInput: "smlou",
        invalidField: invalidField,
        unsaved: true,
        saving: true,
        saveFailure: saveFailure,
        preview: preview,
        assigning: true,
        assignFailure: assignFailure,
        assignment: assignment,
        canSave: true,
        canAssign: true
    )
}
