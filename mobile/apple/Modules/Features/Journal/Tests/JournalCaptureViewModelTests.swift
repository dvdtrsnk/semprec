import CoreKit
import XCTest

@testable import JournalFeature

final class JournalCaptureViewModelTests: XCTestCase {

    @MainActor
    func testEveryIntentIsForwardedToTheModel() {
        let model = ScriptedInboxCaptureScreenModel(state: InboxCaptureState())
        let viewModel = JournalCaptureViewModel(model: model)
        let file = CaptureFile(filename: "a.png", mimeType: "image/png", base64: "YWJj")
        viewModel.loadTypes()
        viewModel.pickType("t1")
        viewModel.pickType(nil)
        viewModel.attach(file, source: .photoLibrary)
        viewModel.removeAttachment()
        viewModel.submit(text: "Note", day: "2026-11-16", time: "08:15")
        viewModel.dismissFailure()
        XCTAssertEqual(model.actions, [
            .loadTypes,
            .pickType("t1"),
            .pickType(nil),
            .attach(filename: "a.png", mimeType: "image/png", base64: "YWJj", source: .photoLibrary),
            .removeAttachment,
            .submit(text: "Note", day: "2026-11-16", time: "08:15"),
            .dismissFailure
        ])
    }

    @MainActor
    func testTheStateIsRepublishedAndEveryCaptureIsCounted() async throws {
        let model = ScriptedInboxCaptureScreenModel(state: InboxCaptureState())
        let viewModel = JournalCaptureViewModel(model: model)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.publish(InboxCaptureState(sending: true))
        try await eventually { viewModel.state.sending }
        XCTAssertEqual(viewModel.captured, 0)
        model.emit(.captured)
        try await eventually { viewModel.captured == 1 }
        model.emit(.captured)
        try await eventually { viewModel.captured == 2 }
        XCTAssertEqual(viewModel.captured, 2)
    }

    @MainActor
    private func eventually(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("The condition did not hold in time")
    }
}
