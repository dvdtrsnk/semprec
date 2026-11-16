import CoreKit
import XCTest

@testable import RecordingsFeature

final class TranscriptAndMeetingViewModelTests: XCTestCase {

    // MARK: - Transcript
    @MainActor
    func testTheTranscriptRepublishesStateAndForwardsEveryIntent() async throws {
        let model = ScriptedTranscriptScreenModel(state: TranscriptState())
        let viewModel = TranscriptViewModel(model: model, router: RouterSpy())
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.publish(TranscriptState(phase: .content, title: "Client meeting"))
        try await eventually { viewModel.state.title == "Client meeting" }
        viewModel.send(.selectTab(.transcript))
        viewModel.send(.search("x"))
        viewModel.send(.togglePlay)
        viewModel.send(.assignSpeaker(personId: "p1"))
        XCTAssertEqual(
            model.actions,
            [.selectTab(.transcript), .search("x"), .togglePlay, .assignSpeaker(personId: "p1")]
        )
    }

    @MainActor
    func testTheEventEffectOfATranscriptReachesTheRouterOnce() async throws {
        let router = RouterSpy()
        let model = ScriptedTranscriptScreenModel(state: TranscriptState())
        let viewModel = TranscriptViewModel(model: model, router: router)
        model.emit(.openEvent(eventId: "e1"))
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        try await eventually { router.calls == ["event:e1"] }
    }

    @MainActor
    func testTheTranscriptRefreshAsksTheModelToRefresh() async {
        let model = ScriptedTranscriptScreenModel(state: TranscriptState(phase: .content))
        let viewModel = TranscriptViewModel(model: model, router: RouterSpy())
        await viewModel.refresh()
        XCTAssertEqual(model.actions, [.refresh])
    }

    @MainActor
    func testReleasingTheTranscriptViewModelReleasesItsModel() {
        weak var weakModel: ScriptedTranscriptScreenModel?
        var viewModel: TranscriptViewModel?
        do {
            let model = ScriptedTranscriptScreenModel(state: TranscriptState())
            weakModel = model
            viewModel = TranscriptViewModel(model: model, router: RouterSpy())
        }
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel)
        XCTAssertNil(viewModel)
    }

    // MARK: - Meeting
    @MainActor
    func testTheMeetingRepublishesStateAndForwardsEveryIntent() async throws {
        let model = ScriptedMeetingScreenModel(state: MeetingState())
        let viewModel = MeetingViewModel(model: model, router: RouterSpy())
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.publish(MeetingState(phase: .content, title: "Client meeting"))
        try await eventually { viewModel.state.title == "Client meeting" }
        viewModel.send(.toggleTask(taskId: "t1"))
        viewModel.send(.addTask(title: "x"))
        viewModel.send(.addSuggestion(transcriptId: "tr1", actionItemId: 2))
        XCTAssertEqual(
            model.actions,
            [.toggleTask(taskId: "t1"), .addTask(title: "x"), .addSuggestion(transcriptId: "tr1", actionItemId: 2)]
        )
    }

    @MainActor
    func testEveryEffectOfTheMeetingReachesTheRouterOnceInOrder() async throws {
        let router = RouterSpy()
        let model = ScriptedMeetingScreenModel(state: MeetingState())
        let viewModel = MeetingViewModel(model: model, router: router)
        model.emit(.showTask(taskId: "t1"))
        model.emit(.showRecording(recordingId: "r1"))
        model.emit(.showNotes(eventId: "e1"))
        model.emit(.showDetails(eventId: "e1"))
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        try await eventually { router.calls.count == 4 }
        XCTAssertEqual(router.calls, ["task:t1", "transcript:r1", "notes:e1", "details:e1"])
    }

    @MainActor
    func testTheMeetingRefreshAsksTheModelToRefresh() async {
        let model = ScriptedMeetingScreenModel(state: MeetingState(phase: .content))
        let viewModel = MeetingViewModel(model: model, router: RouterSpy())
        await viewModel.refresh()
        XCTAssertEqual(model.actions, [.refresh])
    }

    @MainActor
    func testReleasingTheMeetingViewModelReleasesItsModel() {
        weak var weakModel: ScriptedMeetingScreenModel?
        var viewModel: MeetingViewModel?
        do {
            let model = ScriptedMeetingScreenModel(state: MeetingState())
            weakModel = model
            viewModel = MeetingViewModel(model: model, router: RouterSpy())
        }
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel)
        XCTAssertNil(viewModel)
    }
}
