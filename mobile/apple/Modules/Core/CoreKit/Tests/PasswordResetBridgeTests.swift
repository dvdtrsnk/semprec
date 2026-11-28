import SharedSDK
import XCTest

@testable import CoreKit

/// The password-reset bridge: every branch of its mappings over Kotlin values, and the real Kotlin ViewModel behind
/// it. The real ViewModel is only edited, never submitted, so no test sends a request.
final class PasswordResetBridgeTests: XCTestCase {

    // MARK: - Mapping
    @MainActor
    func testEveryPhaseMaps() {
        let cases: [(SharedSDK.PasswordResetState, CoreKit.PasswordResetState)] = [
            (kotlinState(.editing), .editing(canSubmit: false)),
            (kotlinState(.editing, canSubmit: true), .editing(canSubmit: true)),
            (kotlinState(.sending), .sending),
            (kotlinState(.done), .done),
            (kotlinState(.failed, canSubmit: true, failure: .unavailable), .failed(.unavailable, canSubmit: true)),
            (kotlinState(.failed), .failed(nil, canSubmit: false)),
            (
                kotlinState(.failed, canSubmit: true, refusal: .weakPassword),
                .refused(.weakPassword, canSubmit: true)
            )
        ]
        for (kotlin, swift) in cases {
            XCTAssertEqual(SharedPasswordResetScreenModel.state(kotlin), swift)
        }
    }

    @MainActor
    func testEveryRefusalMaps() {
        let cases: [(SharedSDK.PasswordResetRefusalReason, CoreKit.PasswordResetRefusal)] = [
            (.linkInvalid, .linkInvalid),
            (.linkExpired, .linkExpired),
            (.linkUsed, .linkUsed),
            (.weakPassword, .weakPassword)
        ]
        for (kotlin, swift) in cases {
            XCTAssertEqual(SharedPasswordResetScreenModel.refusal(kotlin), swift)
            XCTAssertEqual(
                SharedPasswordResetScreenModel.state(kotlinState(.failed, refusal: kotlin)),
                .refused(swift, canSubmit: false)
            )
        }
    }

    @MainActor
    func testEveryActionMaps() throws {
        let edited = try XCTUnwrap(
            SharedPasswordResetScreenModel.action(.edited(newPassword: "a", repeated: "b"))
                as? SharedSDK.PasswordResetActionEdited
        )
        XCTAssertEqual([edited.newPassword, edited.repeated], ["a", "b"])
        let submit = try XCTUnwrap(
            SharedPasswordResetScreenModel.action(.submit(newPassword: "c", repeated: "d"))
                as? SharedSDK.PasswordResetActionSubmit
        )
        XCTAssertEqual([submit.newPassword, submit.repeated], ["c", "d"])
    }

    // MARK: - Bridge
    @MainActor
    func testTheKotlinViewModelDecidesWhetherTheFormCanBeSent() {
        let model = isolatedFactory().makePasswordReset(serverUrl: "https://alldots.app", token: "tok")
        XCTAssertEqual(model.state, .editing(canSubmit: false))
        model.send(.edited(newPassword: "secret12", repeated: "secret1"))
        XCTAssertEqual(model.state, .editing(canSubmit: false))
        model.send(.edited(newPassword: "secret12", repeated: "secret12"))
        XCTAssertEqual(model.state, .editing(canSubmit: true))
        model.send(.submit(newPassword: "secret12", repeated: "other"))
        XCTAssertEqual(model.state, .editing(canSubmit: false), "Passwords that differ are not sent")
    }

    @MainActor
    func testTheEffectsFinishAtOnce() async {
        let model = isolatedFactory().makePasswordReset(serverUrl: "https://alldots.app", token: "tok")
        var count = 0
        for await _ in model.effects() { count += 1 }
        XCTAssertEqual(count, 0)
    }

    @MainActor
    func testReleasingTheBridgeClosesTheKotlinViewModel() throws {
        var model: SharedPasswordResetScreenModel? = try XCTUnwrap(
            isolatedFactory().makePasswordReset(serverUrl: "https://alldots.app", token: "tok")
                as? SharedPasswordResetScreenModel
        )
        let viewModel = try XCTUnwrap(model?.viewModel)
        let lease = try XCTUnwrap(model?.lease)
        XCTAssertFalse(lease.isClosed)
        model = nil
        XCTAssertTrue(lease.isClosed)
        XCTAssertTrue(viewModel.isClosed)
    }
}

// MARK: - Builders
private extension PasswordResetBridgeTests {

    func kotlinState(
        _ phase: SharedSDK.PasswordResetPhase,
        canSubmit: Bool = false,
        refusal: SharedSDK.PasswordResetRefusalReason? = nil,
        failure: SharedSDK.FailureKind? = nil
    ) -> SharedSDK.PasswordResetState {
        SharedSDK.PasswordResetState(phase: phase, canSubmit: canSubmit, refusal: refusal, failure: failure)
    }
}
