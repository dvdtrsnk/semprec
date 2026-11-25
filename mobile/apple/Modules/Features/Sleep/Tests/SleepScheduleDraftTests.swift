import XCTest

@testable import SleepFeature

/// The schedule the editor's dial moves: five-minute steps, ends that push each other at the shortest and the longest
/// length, the whole snake moving with its length, and times around midnight.
final class SleepScheduleDraftTests: XCTestCase {

    private let lengths = 60...720

    func testAStartingScheduleKeepsItsTimesAndLength() {
        let draft = SleepScheduleDraft(
            days: [1], bedMinutes: 22 * 60 + 30, wakeMinutes: 6 * 60, alarm: false, lengths: lengths
        )

        XCTAssertEqual(draft.bedMinutes, 1_350)
        XCTAssertEqual(draft.wakeMinutes, 360)
        XCTAssertEqual(draft.durationMinutes, 450)
    }

    func testEveryMoveLandsOnAFiveMinuteStep() {
        var draft = SleepScheduleDraft(days: [1], bedMinutes: 1_380, wakeMinutes: 420, alarm: false, lengths: lengths)

        draft.moveBed(to: 1_382)
        XCTAssertEqual(draft.bedMinutes, 1_380)
        draft.moveBed(to: 1_383)
        XCTAssertEqual(draft.bedMinutes, 1_385)
        draft.moveWake(to: 427)
        XCTAssertEqual(draft.wakeMinutes, 425)
        draft.moveAll(bedTo: 61)
        XCTAssertEqual(draft.bedMinutes, 60)
        XCTAssertEqual(draft.bedMinutes % SleepScheduleDraft.stepMinutes, 0)
    }

    func testMovingTheBedtimeKeepsTheWakeTime() {
        var draft = SleepScheduleDraft(days: [1], bedMinutes: 1_380, wakeMinutes: 420, alarm: false, lengths: lengths)

        draft.moveBed(to: 1_320)

        XCTAssertEqual(draft.bedMinutes, 1_320)
        XCTAssertEqual(draft.wakeMinutes, 420)
        XCTAssertEqual(draft.durationMinutes, 540)
    }

    func testShorteningPastTheShortestLengthPushesTheWakeTimeAlong() {
        var draft = SleepScheduleDraft(days: [1], bedMinutes: 1_380, wakeMinutes: 60, alarm: false, lengths: lengths)

        draft.moveBed(to: 0)
        XCTAssertEqual(draft.durationMinutes, lengths.lowerBound)
        XCTAssertEqual(draft.wakeMinutes, 60)

        draft.moveBed(to: 30)
        XCTAssertEqual(draft.bedMinutes, 30)
        XCTAssertEqual(draft.wakeMinutes, 90)
        XCTAssertEqual(draft.durationMinutes, lengths.lowerBound)
    }

    func testShorteningFromTheWakeEndPushesTheBedtimeBack() {
        var draft = SleepScheduleDraft(days: [1], bedMinutes: 1_380, wakeMinutes: 60, alarm: false, lengths: lengths)

        draft.moveWake(to: 1_400)

        XCTAssertEqual(draft.wakeMinutes, 1_400)
        XCTAssertEqual(draft.bedMinutes, 1_340)
        XCTAssertEqual(draft.durationMinutes, lengths.lowerBound)
    }

    func testLengtheningPastTheLongestLengthPullsTheOtherEnd() {
        var draft = SleepScheduleDraft(days: [1], bedMinutes: 1_380, wakeMinutes: 600, alarm: false, lengths: lengths)

        draft.moveWake(to: 720)
        XCTAssertEqual(draft.durationMinutes, lengths.upperBound)
        XCTAssertEqual(draft.bedMinutes, 0)

        draft.moveBed(to: 1_320)
        XCTAssertEqual(draft.durationMinutes, lengths.upperBound)
        XCTAssertEqual(draft.wakeMinutes, 600)
    }

    func testDraggingTheBodyMovesBothEndsAndKeepsTheLength() {
        var draft = SleepScheduleDraft(days: [1], bedMinutes: 1_350, wakeMinutes: 360, alarm: false, lengths: lengths)

        draft.moveAll(bedTo: 1_425)

        XCTAssertEqual(draft.bedMinutes, 1_425)
        XCTAssertEqual(draft.wakeMinutes, 435)
        XCTAssertEqual(draft.durationMinutes, 450)
    }

    func testTimesWrapAroundMidnightBothWays() {
        var draft = SleepScheduleDraft(days: [1], bedMinutes: 5, wakeMinutes: 420, alarm: false, lengths: lengths)

        draft.moveBed(to: -10)
        XCTAssertEqual(draft.bedMinutes, 1_430)
        XCTAssertEqual(draft.durationMinutes, 430)
        XCTAssertEqual(SleepScheduleDraft.signedDistance(from: 1_435, to: 5), 10)
        XCTAssertEqual(SleepScheduleDraft.signedDistance(from: 5, to: 1_435), -10)
    }

    func testAStartingLengthOutOfRangeIsClamped() {
        let short = SleepScheduleDraft(days: [], bedMinutes: 600, wakeMinutes: 610, alarm: false, lengths: lengths)
        let long = SleepScheduleDraft(days: [], bedMinutes: 600, wakeMinutes: 590, alarm: false, lengths: lengths)

        XCTAssertEqual(short.durationMinutes, lengths.lowerBound)
        XCTAssertEqual(long.durationMinutes, lengths.upperBound)
    }

    func testTheLengthsComeFromTheStateTheDraftIsGiven() {
        var draft = SleepScheduleDraft(days: [1], bedMinutes: 1_380, wakeMinutes: 420, alarm: false, lengths: 90...480)

        draft.moveWake(to: 0)
        XCTAssertEqual(draft.durationMinutes, 90)
        XCTAssertEqual(draft.bedMinutes, 1_350)
        draft.moveBed(to: 900)
        XCTAssertEqual(draft.durationMinutes, 480)
        XCTAssertEqual(draft.wakeMinutes, 1_380)
    }
}
