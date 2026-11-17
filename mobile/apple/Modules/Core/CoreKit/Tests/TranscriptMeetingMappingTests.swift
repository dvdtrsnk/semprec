import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the transcript and meeting bridges' mappings between Kotlin and Swift values with Kotlin
/// values built here. Both modules declare most of these type names, so each is qualified with its module.
final class TranscriptMeetingMappingTests: XCTestCase {

    // MARK: - Transcript
    @MainActor
    func testTranscriptMapsTheNotesTheContextTheSegmentsAndThePlayer() {
        let state = SharedTranscriptScreenModel.state(transcriptState())
        XCTAssertEqual(state.phase, .content)
        XCTAssertEqual(state.title, "Client meeting")
        XCTAssertEqual(state.durationSeconds, 4_867)
        XCTAssertEqual(state.status, .done)
        XCTAssertEqual(state.eventId, "e1")
        XCTAssertEqual(state.project, TranscriptContextItem(id: "pr1", name: "Web", inherited: true))
        XCTAssertNil(state.company)
        XCTAssertEqual(state.people.map(\.name), ["Petr"])
        XCTAssertEqual(state.summary, "Budget agreed.")
        XCTAssertEqual(state.decisions, ["Blog later"])
        XCTAssertEqual(state.tab, .transcript)
        XCTAssertEqual(state.matchCount, 2)
        XCTAssertEqual(state.speakerMenu, "S3")
        XCTAssertEqual(state.candidates, [TranscriptCandidateRow(personId: "p3", name: "Jana", current: true)])
        XCTAssertEqual(
            state.player,
            TranscriptPlayer(available: true, failed: false, playing: true, position: 12.5, duration: 100, rate: 1.5)
        )
        XCTAssertEqual(state.writeFailure, Failed(kind: .rejected))
        XCTAssertTrue(state.working)
    }

    @MainActor
    func testTranscriptMapsTheActionItemsAndTheSegments() {
        let state = SharedTranscriptScreenModel.state(transcriptState())
        XCTAssertEqual(state.actionItems.map(\.state), [.open, .added, .noted, .dismissed])
        XCTAssertEqual(state.actionItems[0].id, 0)
        XCTAssertEqual(state.actionItems[0].ownerLabel, "David")
        XCTAssertEqual(state.actionItems[0].due, "2026-10-23")
        XCTAssertTrue(state.actionItems[0].isMine)
        XCTAssertTrue(state.actionItems[1].busy)
        XCTAssertEqual(state.segments.map(\.index), [0, 1])
        XCTAssertEqual(state.segments[0].label, "David")
        XCTAssertEqual(state.segments[0].startsAt, 245)
        XCTAssertEqual(state.segments.map(\.mapped), [true, false])
        XCTAssertEqual(state.segments.map(\.active), [false, true])
    }

    @MainActor
    func testTranscriptMapsEveryPhaseAndTab() {
        let phases: [(SharedSDK.TranscriptPhase, CoreKit.TranscriptPhase)] = [
            (.loading, .loading), (.content, .content), (.error, .error)
        ]
        for (shared, expected) in phases {
            let state = SharedSDK.TranscriptState(
                phase: shared, failure: .notFound, title: "", date: nil, durationSeconds: nil, language: nil,
                status: nil, eventId: nil, eventName: nil, project: nil, company: nil, people: [], summary: nil,
                decisions: [], actionItems: [], tab: .summary, query: "", segments: [], matchCount: 0,
                speakerMenu: nil, candidates: [], player: SharedSDK.TranscriptPlayer(
                    available: false, failed: false, playing: false, position: 0, duration: 0, rate: 1
                ), working: false, writeFailure: nil
            )
            let mapped = SharedTranscriptScreenModel.state(state)
            XCTAssertEqual(mapped.phase, expected)
            XCTAssertEqual(mapped.failure, .notFound)
            XCTAssertEqual(mapped.tab, .summary)
            XCTAssertNil(mapped.durationSeconds)
        }
        XCTAssertEqual(SharedTranscriptScreenModel.sharedTab(.transcript), .transcript)
        XCTAssertEqual(SharedTranscriptScreenModel.tab(.summary), .summary)
    }

    @MainActor
    func testTranscriptMapsEveryAction() {
        typealias Model = SharedTranscriptScreenModel
        XCTAssertTrue(Model.action(.retry) is SharedSDK.TranscriptActionRetry)
        XCTAssertTrue(Model.action(.refresh) is SharedSDK.TranscriptActionRefresh)
        let tab = Model.action(.selectTab(.transcript)) as? SharedSDK.TranscriptActionSelectTab
        XCTAssertEqual(tab?.tab, .transcript)
        XCTAssertEqual((Model.action(.search("x")) as? SharedSDK.TranscriptActionSearch)?.query, "x")
        XCTAssertEqual((Model.action(.seek(seconds: 3.5)) as? SharedSDK.TranscriptActionPlayerSeek)?.seconds, 3.5)
        XCTAssertTrue(Model.action(.togglePlay) is SharedSDK.TranscriptActionPlayerTogglePlay)
        XCTAssertTrue(Model.action(.cycleRate) is SharedSDK.TranscriptActionPlayerCycleRate)
        let open = Model.action(.openSpeakerMenu(speaker: "S1")) as? SharedSDK.TranscriptActionSpeakerOpenMenu
        XCTAssertEqual(open?.speaker, "S1")
        XCTAssertTrue(Model.action(.closeSpeakerMenu) is SharedSDK.TranscriptActionSpeakerCloseMenu)
        let assign = Model.action(.assignSpeaker(personId: "p1")) as? SharedSDK.TranscriptActionSpeakerAssign
        XCTAssertEqual(assign?.personId, "p1")
        let clear = Model.action(.assignSpeaker(personId: nil)) as? SharedSDK.TranscriptActionSpeakerAssign
        XCTAssertNil(clear?.personId)
        XCTAssertEqual((Model.action(.addTask(itemId: 2)) as? SharedSDK.TranscriptActionAddTask)?.itemId, 2)
        XCTAssertEqual((Model.action(.follow(itemId: 3)) as? SharedSDK.TranscriptActionFollow)?.itemId, 3)
        XCTAssertEqual((Model.action(.undo(itemId: 4)) as? SharedSDK.TranscriptActionUndo)?.itemId, 4)
        XCTAssertTrue(Model.action(.openEvent) is SharedSDK.TranscriptActionOpenEvent)
        XCTAssertTrue(Model.action(.dismissFailure) is SharedSDK.TranscriptActionDismissFailure)
        XCTAssertEqual(Model.effect(SharedSDK.TranscriptEffectOpenEvent(eventId: "e1")), .openEvent(eventId: "e1"))
    }

    // MARK: - Meeting
    @MainActor
    func testMeetingMapsTheEventTheTasksTheSuggestionsAndTheRecordings() {
        let state = SharedMeetingScreenModel.state(meetingState())
        XCTAssertEqual(state.phase, .content)
        XCTAssertEqual(state.title, "Client meeting")
        XCTAssertEqual(state.place, "Office")
        XCTAssertEqual(state.timeFrom, "10:00")
        XCTAssertEqual(state.projectColor, "#FF9500")
        XCTAssertEqual(state.companyName, "Novak Web")
        XCTAssertEqual(state.people, [MeetingPersonRow(id: "p1", name: "Petr")])
        XCTAssertEqual(state.tasks.map(\.status), [.open, .missed, .done, .doneElsewhere, .moved])
        XCTAssertEqual(state.tasks[3].detail, "2026-10-14")
        XCTAssertTrue(state.tasks[0].busy)
        XCTAssertEqual(
            state.suggestions,
            [
                MeetingSuggestionRow(
                    transcriptId: "tr1", actionItemId: 4, text: "Wire", ownerLabel: "Jana", due: nil, busy: false
                )
            ]
        )
        XCTAssertEqual(state.suggestions[0].id, "tr1#4")
        XCTAssertEqual(state.recordings.map(\.id), ["r1"])
        XCTAssertEqual(state.writeFailure, Failed(kind: nil))
        XCTAssertTrue(state.working)
    }

    @MainActor
    func testMeetingMapsEveryPhaseEveryActionAndEveryEffect() {
        typealias Model = SharedMeetingScreenModel
        let phases: [(SharedSDK.MeetingPhase, CoreKit.MeetingPhase)] = [
            (.loading, .loading), (.content, .content), (.error, .error)
        ]
        for (shared, expected) in phases {
            XCTAssertEqual(Model.state(meetingState(phase: shared, failure: .unavailable)).phase, expected)
            XCTAssertEqual(Model.state(meetingState(phase: shared, failure: .unavailable)).failure, .unavailable)
        }
        XCTAssertTrue(Model.action(.retry) is SharedSDK.MeetingActionRetry)
        XCTAssertTrue(Model.action(.refresh) is SharedSDK.MeetingActionRefresh)
        XCTAssertEqual((Model.action(.toggleTask(taskId: "t1")) as? SharedSDK.MeetingActionToggleTask)?.taskId, "t1")
        XCTAssertEqual((Model.action(.addTask(title: "x")) as? SharedSDK.MeetingActionAddTask)?.title, "x")
        let suggestion = Model.action(.addSuggestion(transcriptId: "tr1", actionItemId: 4))
            as? SharedSDK.MeetingActionAddSuggestion
        XCTAssertEqual(suggestion?.transcriptId, "tr1")
        XCTAssertEqual(suggestion?.actionItemId, 4)
        XCTAssertEqual((Model.action(.openTask(taskId: "t2")) as? SharedSDK.MeetingActionOpenTask)?.taskId, "t2")
        let recording = Model.action(.openRecording(recordingId: "r1")) as? SharedSDK.MeetingActionOpenRecording
        XCTAssertEqual(recording?.recordingId, "r1")
        XCTAssertTrue(Model.action(.openNotes) is SharedSDK.MeetingActionOpenNotes)
        XCTAssertTrue(Model.action(.openDetails) is SharedSDK.MeetingActionOpenDetails)
        XCTAssertTrue(Model.action(.dismissFailure) is SharedSDK.MeetingActionDismissFailure)
        XCTAssertEqual(Model.effect(SharedSDK.MeetingEffectShowTask(taskId: "t1")), .showTask(taskId: "t1"))
        XCTAssertEqual(
            Model.effect(SharedSDK.MeetingEffectShowRecording(recordingId: "r1")),
            .showRecording(recordingId: "r1")
        )
        XCTAssertEqual(Model.effect(SharedSDK.MeetingEffectShowNotes(eventId: "e1")), .showNotes(eventId: "e1"))
        XCTAssertEqual(Model.effect(SharedSDK.MeetingEffectShowDetails(eventId: "e1")), .showDetails(eventId: "e1"))
    }
}

// MARK: - Kotlin values
private func transcriptState() -> SharedSDK.TranscriptState {
    SharedSDK.TranscriptState(
        phase: .content,
        failure: nil,
        title: "Client meeting",
        date: "2026-10-16T10:02:00+02:00",
        durationSeconds: KotlinInt(int: 4_867),
        language: "cs",
        status: .done,
        eventId: "e1",
        eventName: "Client meeting",
        project: SharedSDK.TranscriptContextItem(id: "pr1", name: "Web", inherited: true),
        company: nil,
        people: [SharedSDK.TranscriptContextItem(id: "p2", name: "Petr", inherited: false)],
        summary: "Budget agreed.",
        decisions: ["Blog later"],
        actionItems: [
            actionRow(0, .open, mine: true, busy: false),
            actionRow(1, .added, mine: false, busy: true),
            actionRow(2, .noted, mine: false, busy: false),
            actionRow(3, .dismissed, mine: false, busy: false)
        ],
        tab: .transcript,
        query: "budget",
        segments: [
            SharedSDK.TranscriptSegmentRow(
                index: 0, speaker: "S1", label: "David", text: "Hello.", startsAt: 245, mapped: true, active: false
            ),
            SharedSDK.TranscriptSegmentRow(
                index: 1, speaker: "S3", label: "Speaker 3", text: "Hi.", startsAt: 262.5, mapped: false, active: true
            )
        ],
        matchCount: 2,
        speakerMenu: "S3",
        candidates: [SharedSDK.TranscriptCandidateRow(personId: "p3", name: "Jana", current: true)],
        player: SharedSDK.TranscriptPlayer(
            available: true, failed: false, playing: true, position: 12.5, duration: 100, rate: 1.5
        ),
        working: true,
        writeFailure: SharedSDK.Failed(kind: .rejected)
    )
}

private func actionRow(
    _ id: Int32,
    _ state: SharedSDK.TranscriptActionState,
    mine: Bool,
    busy: Bool
) -> SharedSDK.TranscriptActionRow {
    SharedSDK.TranscriptActionRow(
        id: id,
        text: "Item \(id)",
        ownerLabel: id == 0 ? "David" : nil,
        due: id == 0 ? "2026-10-23" : nil,
        state: state,
        isMine: mine,
        busy: busy
    )
}

private func meetingState(
    phase: SharedSDK.MeetingPhase = .content,
    failure: SharedSDK.FailureKind? = nil
) -> SharedSDK.MeetingState {
    let statuses: [SharedSDK.MeetingTaskStatus] = [.open, .missed, .done, .doneElsewhere, .moved]
    return SharedSDK.MeetingState(
        phase: phase,
        failure: failure,
        title: "Client meeting",
        place: "Office",
        date: "2026-10-16",
        endDate: nil,
        timeFrom: "10:00",
        timeTo: "11:30",
        projectName: "Web",
        projectColor: "#FF9500",
        companyName: "Novak Web",
        people: [SharedSDK.MeetingPersonRow(id: "p1", name: "Petr")],
        tasks: statuses.enumerated().map { index, status in
            SharedSDK.MeetingTaskRow(
                id: "t\(index)",
                title: "Task \(index)",
                status: status,
                detail: status == .doneElsewhere ? "2026-10-14" : nil,
                busy: index == 0
            )
        },
        suggestions: [
            SharedSDK.MeetingSuggestionRow(
                transcriptId: "tr1", actionItemId: 4, text: "Wire", ownerLabel: "Jana", due: nil, busy: false
            )
        ],
        recordings: [recordingRow(status: .done, pairing: .event)],
        working: true,
        writeFailure: SharedSDK.Failed(kind: nil)
    )
}
