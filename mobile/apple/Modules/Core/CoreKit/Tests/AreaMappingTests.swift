import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the area bridge's mappings between Kotlin and Swift values with Kotlin values built here, and
/// drives the real Kotlin ViewModel through the bridge. Both modules declare most of these type names, so each is
/// qualified with its module.
final class AreaMappingTests: XCTestCase {

    // MARK: - State
    @MainActor
    func testAreaMapsEveryPhaseAndTheFailure() {
        let phases: [
            (SharedSDK.AreaPhase, CoreKit.AreaPhase)
        ] = [(.loading, .loading), (.content, .content), (.error, .error)]
        for (shared, expected) in phases {
            XCTAssertEqual(SharedAreaScreenModel.state(areaState(phase: shared)).phase, expected)
        }
        XCTAssertEqual(SharedAreaScreenModel.state(areaState(phase: .error, failure: .notFound)).failure, .notFound)
        XCTAssertNil(SharedAreaScreenModel.state(areaState(phase: .error)).failure)
    }

    @MainActor
    func testAreaMapsTheContent() {
        let state = SharedAreaScreenModel.state(contentArea())
        XCTAssertEqual(state.name, "Work")
        XCTAssertEqual(state.color, "#5856D6")
        XCTAssertEqual(state.icon, "briefcase")
        XCTAssertFalse(state.active)
        XCTAssertTrue(state.activeSaving)
        XCTAssertEqual(state.tasksToday, 2)
        XCTAssertEqual(state.tasksOpen, 7)
        XCTAssertEqual(state.eventsSoon, 4)
    }

    @MainActor
    func testAreaMapsTheUpcomingItemsTheConnectionsAndTheWriteFailure() {
        let state = SharedAreaScreenModel.state(contentArea())
        XCTAssertEqual(
            state.upcoming,
            [
                AreaUpcomingItem(
                    kind: .task,
                    id: "t1",
                    title: "Invoice",
                    date: "2026-10-21",
                    timeFrom: "14:00",
                    timeTo: nil,
                    projectTitle: "Accounting",
                    projectColor: "#8E8E93"
                ),
                AreaUpcomingItem(
                    kind: .event,
                    id: "e1",
                    title: "Call",
                    date: nil,
                    timeFrom: nil,
                    timeTo: nil,
                    projectTitle: nil,
                    projectColor: nil
                )
            ]
        )
        XCTAssertEqual(
            state.related,
            [
                AreaRelatedItem(
                    databaseId: "d1",
                    databaseKey: "projects",
                    name: "Projects",
                    icon: "folder",
                    color: "#AF52DE",
                    count: 7
                ),
                AreaRelatedItem(databaseId: "d2", databaseKey: nil, name: "Mine", icon: nil, color: nil, count: 1)
            ]
        )
        XCTAssertEqual(state.writeFailure, Failed(kind: .rejected))
    }

    // MARK: - Actions and effects
    @MainActor
    func testAreaMapsEachAction() throws {
        XCTAssertTrue(SharedAreaScreenModel.action(.retry) is SharedSDK.AreaActionRetry)
        XCTAssertTrue(SharedAreaScreenModel.action(.refresh) is SharedSDK.AreaActionRefresh)
        XCTAssertTrue(SharedAreaScreenModel.action(.openNotes) is SharedSDK.AreaActionOpenNotes)
        XCTAssertTrue(SharedAreaScreenModel.action(.dismissFailure) is SharedSDK.AreaActionDismissFailure)
        let tasks = try XCTUnwrap(
            SharedAreaScreenModel.action(.openTasks(todayOnly: true)) as? SharedSDK.AreaActionOpenTasks
        )
        XCTAssertTrue(tasks.todayOnly)
        let upcoming = try XCTUnwrap(
            SharedAreaScreenModel.action(.openUpcoming(id: "t1")) as? SharedSDK.AreaActionOpenUpcoming
        )
        XCTAssertEqual(upcoming.id, "t1")
        let related = try XCTUnwrap(
            SharedAreaScreenModel.action(.openRelated(databaseId: "d1")) as? SharedSDK.AreaActionOpenRelated
        )
        XCTAssertEqual(related.databaseId, "d1")
        let active = try XCTUnwrap(SharedAreaScreenModel.action(.setActive(false)) as? SharedSDK.AreaActionSetActive)
        XCTAssertFalse(active.on)
    }

    @MainActor
    func testAreaMapsEachEffectAndEachCollectionTarget() {
        XCTAssertEqual(
            SharedAreaScreenModel.effect(SharedSDK.AreaEffectOpenTasks(todayOnly: false)),
            .openTasks(todayOnly: false)
        )
        XCTAssertEqual(
            SharedAreaScreenModel.effect(SharedSDK.AreaEffectOpenDetails(kind: .event, id: "e1")),
            .openDetails(kind: .event, id: "e1")
        )
        XCTAssertEqual(SharedAreaScreenModel.effect(SharedSDK.AreaEffectOpenMail.shared), .openMail)
        XCTAssertEqual(SharedAreaScreenModel.effect(SharedSDK.AreaEffectOpenNotes.shared), .openNotes)
        let targets: [(any SharedSDK.CollectionTarget, CoreKit.CollectionTarget)] = [
            (
                SharedSDK.CollectionTargetWhole(databaseKey: "files", databaseId: nil),
                .whole(databaseKey: "files", databaseId: nil)
            ),
            (
                SharedSDK.CollectionTargetOfArea(databaseKey: "files", areaId: "a"),
                .ofArea(databaseKey: "files", areaId: "a")
            ),
            (
                SharedSDK.CollectionTargetOfItem(databaseKey: "files", relationKey: "projects", itemId: "p"),
                .ofItem(databaseKey: "files", relationKey: "projects", itemId: "p")
            ),
            (
                SharedSDK.CollectionTargetMatching(databaseKey: nil, databaseId: "d", filterJson: "{}"),
                .matching(databaseKey: nil, databaseId: "d", filterJson: "{}")
            )
        ]
        for (shared, expected) in targets {
            XCTAssertEqual(
                SharedAreaScreenModel.effect(SharedSDK.AreaEffectOpenCollection(target: shared)),
                .openCollection(expected)
            )
        }
    }

    // MARK: - The real ViewModel
    @MainActor
    func testWithoutASessionTheAreaEndsInTheUnauthorizedFailureAndNotesOpenWithoutData() async throws {
        let model = isolatedFactory().makeArea(areaId: "a1")
        model.send(.openNotes)
        var iterator = model.effects().makeAsyncIterator()
        let effect = await iterator.next()
        XCTAssertEqual(effect, .openNotes)
        let reached = XCTestExpectation(description: "The area failed")
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
    func testReleasingTheAreaBridgeClosesTheKotlinViewModel() throws {
        var model: SharedAreaScreenModel? = try XCTUnwrap(
            isolatedFactory().makeArea(areaId: "a1") as? SharedAreaScreenModel
        )
        let lease = try XCTUnwrap(model?.lease)
        XCTAssertFalse(lease.isClosed)
        model = nil
        XCTAssertTrue(lease.isClosed)
    }
}

// MARK: - Kotlin values
private func areaState(
    phase: SharedSDK.AreaPhase,
    failure: SharedSDK.FailureKind? = nil,
    upcoming: [SharedSDK.AreaUpcomingItem] = [],
    related: [SharedSDK.AreaRelatedItem] = [],
    writeFailure: SharedSDK.Failed? = nil
) -> SharedSDK.AreaState {
    SharedSDK.AreaState(
        phase: phase,
        failure: failure,
        name: "Work",
        color: "#5856D6",
        icon: "briefcase",
        active: false,
        activeSaving: true,
        tasksToday: 2,
        tasksOpen: 7,
        eventsSoon: 4,
        upcoming: upcoming,
        related: related,
        writeFailure: writeFailure
    )
}

private func contentArea() -> SharedSDK.AreaState {
    areaState(
            phase: .content,
            upcoming: [
                SharedSDK.AreaUpcomingItem(
                    kind: .task,
                    id: "t1",
                    title: "Invoice",
                    date: "2026-10-21",
                    timeFrom: "14:00",
                    timeTo: nil,
                    projectTitle: "Accounting",
                    projectColor: "#8E8E93"
                ),
                SharedSDK.AreaUpcomingItem(
                    kind: .event,
                    id: "e1",
                    title: "Call",
                    date: nil,
                    timeFrom: nil,
                    timeTo: nil,
                    projectTitle: nil,
                    projectColor: nil
                )
            ],
            related: [
                SharedSDK.AreaRelatedItem(
                    databaseId: "d1",
                    databaseKey: "projects",
                    name: "Projects",
                    icon: "folder",
                    color: "#AF52DE",
                    count: 7,
                    filterJson: "{}"
                ),
                SharedSDK.AreaRelatedItem(
                    databaseId: "d2", databaseKey: nil, name: "Mine", icon: nil, color: nil, count: 1, filterJson: nil
                )
            ],
            writeFailure: SharedSDK.Failed(kind: .rejected)
        )
}
