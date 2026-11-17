import SharedSDK
import XCTest

@testable import CoreKit

/// Every branch of the agenda's bridge, with the Kotlin values it maps.
@MainActor
final class CalendarAgendaMappingTests: XCTestCase {

    private typealias Model = SharedCalendarAgendaScreenModel

    func testTheStateMapsItsDaysEntriesAndFurtherPage() {
        let entry = SharedSDK.CalendarAgendaEntry(
            id: "e1", kind: .event, title: "Meeting", timeFrom: "14:00", timeTo: "15:00",
            allDay: false, done: false, place: "Praha"
        )
        let state = SharedSDK.CalendarAgendaState(
            phase: .content,
            failure: nil,
            days: [SharedSDK.CalendarAgendaDay(day: "2026-11-16", entries: [entry])],
            hasMore: true,
            loadingMore: true,
            moreFailure: SharedSDK.Failed(kind: .unavailable)
        )
        XCTAssertEqual(
            Model.state(state),
            CoreKit.CalendarAgendaState(
                phase: .content,
                days: [
                    CoreKit.CalendarAgendaDay(day: "2026-11-16", entries: [
                        CoreKit.CalendarAgendaEntry(
                            id: "e1", kind: .event, title: "Meeting", timeFrom: "14:00", timeTo: "15:00",
                            allDay: false, done: false, place: "Praha"
                        )
                    ])
                ],
                hasMore: true,
                loadingMore: true,
                moreFailure: CoreKit.Failed(kind: .unavailable)
            )
        )
    }

    func testEveryPhaseAndKindMaps() {
        XCTAssertEqual(Model.phase(.loading, failure: nil), .loading)
        XCTAssertEqual(Model.phase(.content, failure: nil), .content)
        XCTAssertEqual(Model.phase(.error, failure: .unauthorized), .failure(.unauthorized))
        XCTAssertEqual(Model.phase(.error, failure: nil), .failure(nil))
        XCTAssertEqual(Model.kind(.event), .event)
        XCTAssertEqual(Model.kind(.task), .task)
    }

    func testActionsAndTheEffectMap() throws {
        XCTAssertTrue(Model.action(.retry) is SharedSDK.CalendarAgendaActionRetry)
        XCTAssertTrue(Model.action(.loadMore) is SharedSDK.CalendarAgendaActionLoadMore)
        let open = try XCTUnwrap(Model.action(.open(id: "e1")) as? SharedSDK.CalendarAgendaActionOpen)
        XCTAssertEqual(open.id, "e1")
        XCTAssertEqual(
            Model.effect(SharedSDK.CalendarAgendaEffectOpenDetails(kind: .task, id: "t1")),
            .openDetails(kind: .task, id: "t1")
        )
    }

    func testTheRealViewModelClosesWithItsBridge() throws {
        var model: SharedCalendarAgendaScreenModel? = try XCTUnwrap(
            isolatedFactory().makeCalendarAgenda(from: "2026-11-16") as? SharedCalendarAgendaScreenModel
        )
        let lease = try XCTUnwrap(model?.lease)
        XCTAssertFalse(lease.isClosed)
        model = nil
        XCTAssertTrue(lease.isClosed)
    }
}
