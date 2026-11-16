import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the recordings, recorder, transcript and meeting bridges' mappings between Kotlin and Swift
/// values with Kotlin values built here, and drives the real Kotlin ViewModels through the bridges. Both modules
/// declare most of these type names, so each is qualified with its module.
final class RecordingsMappingTests: XCTestCase {

    // MARK: - Recordings
    @MainActor
    func testRecordingsMapsEveryPhaseAndTheRowsWithEveryStatusAndPairing() {
        let phases: [(SharedSDK.RecordingsPhase, CoreKit.RecordingsPhase)] = [
            (.loading, .loading), (.content, .content), (.error, .error)
        ]
        for (shared, expected) in phases {
            let state = SharedSDK.RecordingsState(phase: shared, failure: nil, recordings: [])
            XCTAssertEqual(SharedRecordingsScreenModel.state(state).phase, expected)
        }
        let statuses: [(SharedSDK.RecordingStatus?, CoreKit.RecordingStatus?)] = [
            (.recording, .recording), (.processing, .processing), (.done, .done), (.error, .error), (nil, nil)
        ]
        let pairings: [(SharedSDK.RecordingPairing, CoreKit.RecordingPairing)] = [
            (.processing, .processing), (.event, .event), (.awaitingEvent, .awaitingEvent), (.none, .unpaired)
        ]
        for (status, expectedStatus) in statuses {
            for (pairing, expectedPairing) in pairings {
                let mapped = RecordingRow(recordingRow(status: status, pairing: pairing))
                XCTAssertEqual(mapped.status, expectedStatus)
                XCTAssertEqual(mapped.pairing, expectedPairing)
            }
        }
    }

    @MainActor
    func testRecordingsMapsTheFieldsOfARowAndTheFailure() {
        let state = SharedRecordingsScreenModel.state(
            SharedSDK.RecordingsState(
                phase: .error,
                failure: .unavailable,
                recordings: [recordingRow(status: .processing, pairing: .processing)]
            )
        )
        XCTAssertEqual(state.failure, .unavailable)
        let row = state.recordings[0]
        XCTAssertEqual(row.id, "r1")
        XCTAssertEqual(row.name, "Client meeting")
        XCTAssertEqual(row.durationSeconds, 4_867)
        XCTAssertEqual(row.eventName, "Client meeting")
        XCTAssertEqual(row.shortSummary, "Budget agreed.")
        XCTAssertTrue(row.processing)
        let bare = RecordingRow(
            SharedSDK.RecordingRow(
                id: "r2", name: "N", date: nil, durationSeconds: nil, status: nil, pairing: .none,
                eventName: nil, shortSummary: nil
            )
        )
        XCTAssertNil(bare.durationSeconds)
        XCTAssertNil(bare.date)
        XCTAssertFalse(bare.processing)
    }

    @MainActor
    func testRecordingsMapsEachActionAndEffect() {
        XCTAssertTrue(SharedRecordingsScreenModel.action(.retry) is SharedSDK.RecordingsActionRetry)
        XCTAssertTrue(SharedRecordingsScreenModel.action(.refresh) is SharedSDK.RecordingsActionRefresh)
        let open = SharedRecordingsScreenModel.action(.open(recordingId: "r1")) as? SharedSDK.RecordingsActionOpen
        XCTAssertEqual(open?.recordingId, "r1")
        XCTAssertEqual(
            SharedRecordingsScreenModel.effect(SharedSDK.RecordingsEffectOpenTranscript(recordingId: "r1")),
            .openTranscript(recordingId: "r1")
        )
    }

    // MARK: - Recorder
    @MainActor
    func testRecorderMapsEveryPhaseAndProblem() {
        let phases: [(SharedSDK.RecorderPhase, CoreKit.RecorderPhase)] = [
            (.idle, .idle), (.recording, .recording), (.paused, .paused), (.saving, .saving),
            (.uploading, .uploading), (.failed, .failed)
        ]
        for (shared, expected) in phases {
            XCTAssertEqual(SharedRecorderScreenModel.phase(shared), expected)
        }
        let problems: [(SharedSDK.RecorderProblem, CoreKit.RecorderProblem)] = [
            (.permissionDenied, .permissionDenied), (.startFailed, .startFailed), (.captureFailed, .captureFailed),
            (.importFailed, .importFailed), (.uploadFailed, .uploadFailed)
        ]
        for (shared, expected) in problems {
            XCTAssertEqual(SharedRecorderScreenModel.problem(shared), expected)
        }
    }

    @MainActor
    func testRecorderMapsTheClockTheLevelsTheProblemAndBusy() {
        let state = SharedRecorderScreenModel.state(
            SharedSDK.RecorderState(
                phase: .failed,
                elapsedSeconds: 42,
                levels: [KotlinFloat(float: 0.25), KotlinFloat(float: 1)],
                problem: .uploadFailed,
                failure: .unavailable
            )
        )
        XCTAssertEqual(state.elapsedSeconds, 42)
        XCTAssertEqual(state.levels, [0.25, 1])
        XCTAssertEqual(state.problem, .uploadFailed)
        XCTAssertEqual(state.failure, .unavailable)
        XCTAssertFalse(state.busy)
        let recording = SharedRecorderScreenModel.state(
            SharedSDK.RecorderState(phase: .recording, elapsedSeconds: 1, levels: [], problem: nil, failure: nil)
        )
        XCTAssertTrue(recording.busy)
        XCTAssertNil(recording.problem)
    }

    @MainActor
    func testRecorderMapsEveryActionAndTheEffect() {
        XCTAssertTrue(SharedRecorderScreenModel.action(.start) is SharedSDK.RecorderActionStart)
        XCTAssertTrue(SharedRecorderScreenModel.action(.pause) is SharedSDK.RecorderActionPause)
        XCTAssertTrue(SharedRecorderScreenModel.action(.resume) is SharedSDK.RecorderActionResume)
        XCTAssertTrue(SharedRecorderScreenModel.action(.stop) is SharedSDK.RecorderActionStop)
        XCTAssertTrue(SharedRecorderScreenModel.action(.discard) is SharedSDK.RecorderActionDiscard)
        XCTAssertTrue(SharedRecorderScreenModel.action(.retry) is SharedSDK.RecorderActionRetry)
        let imported = SharedRecorderScreenModel.action(.importFile(path: "/a.m4a")) as? SharedSDK.RecorderActionImport
        XCTAssertEqual(imported?.path, "/a.m4a")
        XCTAssertEqual(SharedRecorderScreenModel.effect(SharedSDK.RecorderEffectUploaded.shared), .uploaded)
    }

    // MARK: - The real ViewModels
    @MainActor
    func testWithoutASessionTheRecordingsEndInTheUnauthorizedFailure() async {
        let model = isolatedFactory().makeRecordings()
        let reached = XCTestExpectation(description: "The recordings failed")
        let observer = Task { @MainActor in
            for await state in model.states() where state.phase == .error {
                XCTAssertEqual(state.failure, .unauthorized)
                reached.fulfill()
                return
            }
        }
        await fulfillment(of: [reached], timeout: 5)
        observer.cancel()
    }

    @MainActor
    func testTheRealRecorderStartsIdleAndNotBusy() {
        let model = isolatedFactory().makeRecorder(eventId: "e1")
        XCTAssertEqual(model.state.phase, .idle)
        XCTAssertFalse(model.state.busy)
    }

    @MainActor
    func testReleasingARecordingsBridgeClosesItsKotlinViewModel() throws {
        let factory = isolatedFactory()
        var recordings: SharedRecordingsScreenModel? = try XCTUnwrap(
            factory.makeRecordings() as? SharedRecordingsScreenModel
        )
        var recorder: SharedRecorderScreenModel? = try XCTUnwrap(
            factory.makeRecorder(eventId: nil) as? SharedRecorderScreenModel
        )
        var transcript: SharedTranscriptScreenModel? = try XCTUnwrap(
            factory.makeTranscript(transcriptId: "t") as? SharedTranscriptScreenModel
        )
        var meeting: SharedMeetingScreenModel? = try XCTUnwrap(
            factory.makeMeeting(eventId: "e") as? SharedMeetingScreenModel
        )
        let leases = [recordings?.lease, recorder?.lease, transcript?.lease, meeting?.lease].compactMap { $0 }
        XCTAssertEqual(leases.count, 4)
        XCTAssertTrue(leases.allSatisfy { !$0.isClosed })
        recordings = nil
        recorder = nil
        transcript = nil
        meeting = nil
        XCTAssertTrue(leases.allSatisfy(\.isClosed))
    }
}

// MARK: - Kotlin values
func recordingRow(
    status: SharedSDK.RecordingStatus?,
    pairing: SharedSDK.RecordingPairing
) -> SharedSDK.RecordingRow {
    SharedSDK.RecordingRow(
        id: "r1",
        name: "Client meeting",
        date: "2026-10-16T10:02:00+02:00",
        durationSeconds: KotlinInt(int: 4_867),
        status: status,
        pairing: pairing,
        eventName: "Client meeting",
        shortSummary: "Budget agreed."
    )
}
