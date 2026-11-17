import CoreKit
import NavigatorUI
import OverviewFeature
import XCTest

@testable import Semprec

/// The routes of the recordings, the transcript and the page of an event: which stack they reach and how.
final class RecordingsNavigationTests: XCTestCase {

    // MARK: - Overview
    @MainActor
    func testTheRecordingsRowOfTheOverviewPushesTheRecordingsOntoTheOverviewStack() {
        let context = NavigationContext()
        let overview = StackSpy()
        context.register(overview, for: .overview)
        AppOverviewRouter(context: context).show(.recordings)
        XCTAssertEqual(overview.pushed, [.recordings(tab: .overview)])
    }

    // MARK: - Recordings
    @MainActor
    func testATranscriptTheEventAndItsNotesAreLeftOnTheStackOfTheTabThatAsked() {
        let context = NavigationContext()
        let overview = StackSpy()
        let calendar = StackSpy()
        context.register(overview, for: .overview)
        context.register(calendar, for: .calendar)
        let router = AppRecordingsRouter(context: context, tab: .calendar)
        router.showTranscript(recordingId: "r1")
        router.showEvent(eventId: "e1")
        router.showNotes(eventId: "e1")
        XCTAssertEqual(
            calendar.pushed,
            [
                .transcript(recordingId: "r1", tab: .calendar),
                .meeting(eventId: "e1", tab: .calendar),
                .notes(itemId: "e1", tab: .calendar)
            ]
        )
        XCTAssertTrue(overview.pushed.isEmpty)
    }

    @MainActor
    func testATaskAndTheEventOfThePageOpenTheirPodrobnostiAsSheets() {
        let context = NavigationContext()
        let calendar = StackSpy()
        context.register(calendar, for: .calendar)
        let router = AppRecordingsRouter(context: context, tab: .calendar)
        router.showTask(taskId: "t1")
        router.showEventDetails(eventId: "e1")
        XCTAssertEqual(
            calendar.sheets,
            [
                .details(ItemDetailsTarget(kind: .task, id: "t1")),
                .details(ItemDetailsTarget(kind: .event, id: "e1"))
            ]
        )
        XCTAssertTrue(calendar.pushed.isEmpty)
    }

    // MARK: - The page row of the Podrobnosti sheet
    @MainActor
    func testTheSheetOfAnEventOpensItsPageOntoTheStackItWasPresentedOver() throws {
        let composition = AppComposition(models: SignedInModels())
        let calendar = StackSpy()
        let overview = StackSpy()
        composition.navigation.register(calendar, for: .calendar)
        composition.navigation.register(overview, for: .overview)
        let target = ItemDetailsTarget(kind: .event, id: "e1", tab: .calendar)
        let open = try XCTUnwrap(AppScene.eventPageOpener(for: target, composition: composition))
        open()
        XCTAssertEqual(calendar.pushed, [.meeting(eventId: "e1", tab: .calendar)])
        XCTAssertTrue(overview.pushed.isEmpty)
    }

    @MainActor
    func testATaskAndAnEventWithoutAStackHaveNoPageToOpen() {
        let composition = AppComposition(models: SignedInModels())
        XCTAssertNil(
            AppScene.eventPageOpener(
                for: ItemDetailsTarget(kind: .task, id: "t1", tab: .calendar),
                composition: composition
            )
        )
        XCTAssertNil(
            AppScene.eventPageOpener(for: ItemDetailsTarget(kind: .event, id: "e1"), composition: composition)
        )
    }
}

// MARK: - Spies
@MainActor
private final class StackSpy: StackNavigating {

    // MARK: - Properties
    private(set) var pushed: [AppDestination] = []
    private(set) var sheets: [AppDestination] = []

    var top: AppDestination? { pushed.last }

    // MARK: - Protocol conformance
    func push(_ destination: AppDestination) {
        pushed.append(destination)
    }

    func presentSheet(_ destination: AppDestination) {
        sheets.append(destination)
    }

    func dismissPresented() {}
}
