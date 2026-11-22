import CoreKit
import XCTest

@testable import MailFeature

final class ProjectMailSignalsViewModelTests: XCTestCase {

    @MainActor
    func testTheScreenStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedProjectMailSignalsScreenModel(state: ProjectMailSignalsState())
        let viewModel = ProjectMailSignalsViewModel(model: model)
        XCTAssertEqual(viewModel.state.phase, .loading)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.publish(PreviewMail.signals)
        try await eventually { viewModel.state == PreviewMail.signals }
    }

    @MainActor
    func testEveryIntentIsForwardedToTheSharedModel() {
        let model = ScriptedProjectMailSignalsScreenModel(state: PreviewMail.signals)
        let viewModel = ProjectMailSignalsViewModel(model: model)
        let actions: [ProjectMailSignalsAction] = [
            .editInput(.domains, text: "novak.cz"),
            .add(.domains),
            .remove(.keywords, value: "faktura"),
            .save,
            .assign,
            .retryPreview,
            .dismissAssignment,
            .dismissFailure,
            .retry
        ]
        actions.forEach(viewModel.send)
        XCTAssertEqual(model.actions, actions)
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedProjectMailSignalsScreenModel?
        var viewModel: ProjectMailSignalsViewModel?
        do {
            let model = ScriptedProjectMailSignalsScreenModel(state: ProjectMailSignalsState())
            weakModel = model
            viewModel = ProjectMailSignalsViewModel(model: model)
        }
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(viewModel)
        XCTAssertNil(weakModel, "The screen's ViewModel must own its model alone")
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
