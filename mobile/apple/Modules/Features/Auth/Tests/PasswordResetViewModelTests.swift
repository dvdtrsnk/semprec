import CoreKit
import XCTest

@testable import AuthFeature

final class PasswordResetViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedPasswordResetScreenModel(state: .editing(canSubmit: false))
        let viewModel = PasswordResetViewModel(model: model)
        XCTAssertEqual(viewModel.state, .editing(canSubmit: false))
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        defer { observer.cancel() }
        model.publish(.sending)
        try await eventually { viewModel.state == .sending }
        model.publish(.done)
        try await eventually { viewModel.state == .done }
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testIntentsAreForwardedToTheModel() {
        let model = ScriptedPasswordResetScreenModel(state: .editing(canSubmit: false))
        let viewModel = PasswordResetViewModel(model: model)
        viewModel.edited(newPassword: "secret12", repeated: "secret1")
        viewModel.submit(newPassword: "secret12", repeated: "secret12")
        XCTAssertEqual(
            model.actions,
            [
                .edited(newPassword: "secret12", repeated: "secret1"),
                .submit(newPassword: "secret12", repeated: "secret12")
            ]
        )
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedPasswordResetScreenModel?
        var viewModel: PasswordResetViewModel?
        do {
            let model = ScriptedPasswordResetScreenModel(state: .sending)
            weakModel = model
            viewModel = PasswordResetViewModel(model: model)
        }
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel)
        XCTAssertNil(viewModel)
    }

    @MainActor
    func testTheSubmitButtonFollowsTheSharedDecision() {
        let enabled: [PasswordResetState] = [
            .editing(canSubmit: true), .refused(.weakPassword, canSubmit: true), .failed(.unavailable, canSubmit: true)
        ]
        let disabled: [PasswordResetState] = [
            .editing(canSubmit: false), .sending, .done, .refused(.linkExpired, canSubmit: false),
            .failed(nil, canSubmit: false)
        ]
        XCTAssertTrue(enabled.allSatisfy(\.canSubmit))
        XCTAssertFalse(disabled.contains(where: \.canSubmit))
        XCTAssertTrue(PasswordResetState.sending.isSending)
        XCTAssertTrue(PasswordResetState.done.isDone)
        XCTAssertFalse(PasswordResetState.editing(canSubmit: true).isDone)
    }

    @MainActor
    func testEveryRefusalAndTheUnavailableServerHaveTheirOwnMessage() {
        let refusals: [PasswordResetRefusal] = [.linkInvalid, .linkExpired, .linkUsed, .weakPassword]
        let refused = refusals.compactMap { PasswordResetState.refused($0, canSubmit: false).failureMessage }
        let unavailable = PasswordResetState.failed(.unavailable, canSubmit: true).failureMessage
        let unexpected = PasswordResetState.failed(nil, canSubmit: true).failureMessage
        let messages = refused + [unavailable, unexpected].compactMap { $0 }
        XCTAssertEqual(Set(messages).count, 6, "Each refusal, the unavailable server and the rest have their own text")
        let others: [FailureKind] = [.rejected, .unauthorized, .invalidData, .notFound]
        XCTAssertEqual(Set(others.map { PasswordResetState.failed($0, canSubmit: true).failureMessage }), [unexpected])
        XCTAssertNil(PasswordResetState.editing(canSubmit: true).failureMessage)
        XCTAssertNil(PasswordResetState.sending.failureMessage)
        XCTAssertNil(PasswordResetState.done.failureMessage)
    }

    // MARK: - Helpers
    @MainActor
    private func eventually(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("The condition did not hold in time")
    }
}
