import CoreKit
import XCTest

@testable import SleepFeature

/// The hit-testing of the sleep dial: which minute a point is, and which part of the snake a finger takes hold of.
final class DialGrabTests: XCTestCase {

    // MARK: - Properties
    private let geometry = DialGeometry(size: 300, stepMinutes: 5)
    private let draft = SleepDraft.previewWeekdays

    // MARK: - Minutes
    func testTheDialStartsAtMidnightAtTheTopAndRunsClockwise() {
        XCTAssertEqual(geometry.minutes(at: point(minutes: 0)), 0, accuracy: 0.001)
        XCTAssertEqual(geometry.minutes(at: point(minutes: 360)), 360, accuracy: 0.001)
        XCTAssertEqual(geometry.minutes(at: point(minutes: 720)), 720, accuracy: 0.001)
        XCTAssertEqual(geometry.minutes(at: point(minutes: 1_080)), 1_080, accuracy: 0.001)
        XCTAssertEqual(geometry.minutes(at: point(minutes: 1_430)), 1_430, accuracy: 0.001)
    }

    func testTheShorterWayRoundTheDialIsSignedClockwise() {
        XCTAssertEqual(DialGeometry.signedDistance(from: 1_380, to: 60), 120)
        XCTAssertEqual(DialGeometry.signedDistance(from: 60, to: 1_380), -120)
        XCTAssertEqual(DialGeometry.signedDistance(from: 0, to: 720), 720)
        XCTAssertEqual(DialGeometry.wrapped(-30), 1_410)
        XCTAssertEqual(DialGeometry.wrapped(1_500), 60)
    }

    // MARK: - Track
    func testOnlyTheTrackTakesATouch() {
        XCTAssertTrue(geometry.isOnTrack(point(minutes: 100)))
        XCTAssertFalse(geometry.isOnTrack(CGPoint(x: 150, y: 150)))
        XCTAssertFalse(geometry.isOnTrack(CGPoint(x: 150, y: 150 - geometry.radius * 0.5)))
    }

    // MARK: - Grab
    func testAFingerOnABedEndHoldsTheBedtime() {
        let grab = DialGrab.start(at: point(minutes: 1_380), geometry: geometry, draft: draft)

        XCTAssertEqual(grab?.handle, .bed)
        XCTAssertEqual(grab?.offsetMinutes ?? .nan, 0, accuracy: 0.001)
    }

    func testAFingerOnAWakeEndHoldsTheWakeTime() {
        let grab = DialGrab.start(at: point(minutes: 405), geometry: geometry, draft: draft)

        XCTAssertEqual(grab?.handle, .wake)
    }

    func testAFingerBesideAnEndKeepsItsDistanceSoTheEndDoesNotJump() {
        let grab = DialGrab.start(at: point(minutes: 1_390), geometry: geometry, draft: draft)

        XCTAssertEqual(grab?.handle, .bed)
        XCTAssertEqual(grab?.offsetMinutes ?? .nan, -10, accuracy: 0.001)
        XCTAssertEqual(grab?.target(at: point(minutes: 1_400), geometry: geometry), 1_390)
    }

    func testAFingerOnTheBodyHoldsTheWholeNight() {
        let grab = DialGrab.start(at: point(minutes: 120), geometry: geometry, draft: draft)

        XCTAssertEqual(grab?.handle, .whole)
        XCTAssertEqual(grab?.offsetMinutes ?? .nan, -180, accuracy: 0.001)
        XCTAssertEqual(grab?.target(at: point(minutes: 180), geometry: geometry), 0)
    }

    func testAFingerOffTheSnakeHoldsNothing() {
        XCTAssertNil(DialGrab.start(at: point(minutes: 720), geometry: geometry, draft: draft))
        XCTAssertNil(DialGrab.start(at: CGPoint(x: 150, y: 150), geometry: geometry, draft: draft))
    }

    // MARK: - Moves
    func testAMoveIsSentOnlyWhenTheFingerReachesAnotherStep() {
        var grab = DialGrab(handle: .bed, offsetMinutes: 0, lastSentStep: nil)

        XCTAssertEqual(grab.move(to: 1_380, stepMinutes: 5), 1_380)
        XCTAssertNil(grab.move(to: 1_381, stepMinutes: 5))
        XCTAssertNil(grab.move(to: 1_379, stepMinutes: 5))
        XCTAssertEqual(grab.move(to: 1_383, stepMinutes: 5), 1_383)
        XCTAssertEqual(grab.move(to: 1_370, stepMinutes: 5), 1_370)
        XCTAssertEqual(grab.lastSentStep, 274)
    }

    func testAZeroStepDoesNotDivideByZero() {
        var grab = DialGrab(handle: .wake, offsetMinutes: 0, lastSentStep: nil)

        XCTAssertEqual(grab.move(to: 7, stepMinutes: 0), 7)
        XCTAssertNil(grab.move(to: 7, stepMinutes: 0))
    }

    // MARK: - Helpers
    /// The point of the snake's track at a minute of the day, for a dial 300 points wide.
    private func point(minutes: Double) -> CGPoint {
        let offset = geometry.offset(minutes: minutes, radius: geometry.snakeRadius)
        return CGPoint(x: 150 + offset.width, y: 150 + offset.height)
    }
}
