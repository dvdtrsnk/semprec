import CoreKit
import XCTest

@testable import RecordingsFeature

final class RecordingsViewModelTests: XCTestCase {

    // MARK: - Recordings
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedRecordingsScreenModel(state: RecordingsState())
        let viewModel = RecordingsViewModel(model: model, router: RouterSpy())
        XCTAssertEqual(viewModel.state.phase, .loading)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.publish(RecordingsState(phase: .content, recordings: [row("r1")]))
        try await eventually { viewModel.state.recordings.count == 1 }
    }

    @MainActor
    func testIntentsAreForwardedToTheModel() {
        let model = ScriptedRecordingsScreenModel(state: RecordingsState())
        let viewModel = RecordingsViewModel(model: model, router: RouterSpy())
        viewModel.send(.retry)
        viewModel.send(.open(recordingId: "r1"))
        XCTAssertEqual(model.actions, [.retry, .open(recordingId: "r1")])
    }

    @MainActor
    func testTheTranscriptEffectReachesTheRouterOnceAlsoWhenRaisedBeforeObservation() async throws {
        let router = RouterSpy()
        let model = ScriptedRecordingsScreenModel(state: RecordingsState())
        let viewModel = RecordingsViewModel(model: model, router: router)
        model.emit(.openTranscript(recordingId: "r1"))
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        try await eventually { router.calls == ["transcript:r1"] }
        observer.cancel()
        let second = Task { await viewModel.observe() }
        defer { second.cancel() }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(router.calls, ["transcript:r1"])
    }

    @MainActor
    func testRefreshReturnsOnceTheListIsNoLongerLoading() async {
        let model = ScriptedRecordingsScreenModel(state: RecordingsState(phase: .content))
        let viewModel = RecordingsViewModel(model: model, router: RouterSpy())
        await viewModel.refresh()
        XCTAssertEqual(model.actions, [.refresh])
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedRecordingsScreenModel?
        var viewModel: RecordingsViewModel?
        do {
            let model = ScriptedRecordingsScreenModel(state: RecordingsState())
            weakModel = model
            viewModel = RecordingsViewModel(model: model, router: RouterSpy())
        }
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel)
        XCTAssertNil(viewModel)
    }

    // MARK: - Recorder
    @MainActor
    func testTheRecorderRepublishesStateForwardsIntentsAndReportsEachUpload() async throws {
        let model = ScriptedRecorderScreenModel(state: RecorderState())
        let viewModel = RecorderViewModel(model: model)
        let uploads = Received<Int>()
        let observer = Task { await viewModel.observe { uploads.append(1) } }
        defer { observer.cancel() }
        model.publish(RecorderState(phase: .recording, elapsedSeconds: 3, busy: true))
        try await eventually { viewModel.state.elapsedSeconds == 3 }
        viewModel.send(.stop)
        model.emit(.uploaded)
        try await eventually { uploads.values.count == 1 }
        XCTAssertEqual(model.actions, [.stop])
        XCTAssertTrue(viewModel.state.busy)
    }

    // MARK: - Helpers
    private func row(_ id: String) -> RecordingRow {
        RecordingRow(
            id: id,
            name: "N",
            date: nil,
            durationSeconds: nil,
            status: .done,
            pairing: .unpaired,
            eventName: nil,
            shortSummary: nil,
            processing: false
        )
    }
}

// MARK: - Spies
/// Values a test task received on the main actor.
@MainActor
final class Received<Value> {

    // MARK: - Properties
    private(set) var values: [Value] = []

    // MARK: - Methods
    func append(_ value: Value) {
        values.append(value)
    }
}
