import CoreKit
import XCTest

@testable import AuthFeature

final class LoginViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedLoginScreenModel(state: .editing(resetRequested: false))
        let viewModel = LoginViewModel(model: model)
        XCTAssertEqual(viewModel.state, .editing(resetRequested: false))
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        defer { observer.cancel() }
        model.publish(.signingIn)
        try await eventually { viewModel.state == .signingIn }
        model.publish(.failed(.unauthorized))
        try await eventually { viewModel.state == .failed(.unauthorized) }
        XCTAssertEqual(viewModel.state, .failed(.unauthorized))
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testIntentsAreForwardedToTheModel() {
        let model = ScriptedLoginScreenModel(state: .editing(resetRequested: false))
        let viewModel = LoginViewModel(model: model)
        viewModel.signIn(server: "s.example", email: "a@b.cz", password: "secret")
        viewModel.forgotPassword(server: "s.example", email: "a@b.cz")
        viewModel.edited()
        XCTAssertEqual(
            model.actions,
            [
                .signIn(server: "s.example", email: "a@b.cz", password: "secret"),
                .forgotPassword(server: "s.example", email: "a@b.cz"),
                .edited
            ]
        )
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedLoginScreenModel?
        var viewModel: LoginViewModel?
        do {
            let model = ScriptedLoginScreenModel(state: .signingIn)
            weakModel = model
            viewModel = LoginViewModel(model: model)
        }
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel)
        XCTAssertNil(viewModel)
    }

    @MainActor
    func testMessagesFollowTheState() {
        XCTAssertNil(LoginState.editing(resetRequested: false).message)
        XCTAssertNil(LoginState.signingIn.message)
        XCTAssertNotNil(LoginState.editing(resetRequested: true).message)
        let failures: [FailureKind?] = [.rejected, .unauthorized, .unavailable, .invalidData, .notFound, nil]
        let messages = Set(failures.compactMap { LoginState.failed($0).message })
        // Each typed failure the form can meet has its own text; the rest share the unexpected one.
        XCTAssertEqual(messages.count, 4)
        XCTAssertTrue(LoginState.failed(nil).isFailure)
        XCTAssertFalse(LoginState.signingIn.isFailure)
        XCTAssertTrue(LoginState.signingIn.isSigningIn)
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
