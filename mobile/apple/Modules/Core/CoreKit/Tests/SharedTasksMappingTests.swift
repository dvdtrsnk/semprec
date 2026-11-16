import SharedSDK
import XCTest

@testable import CoreKit

private typealias Tasks = SharedTasksScreenModel

/// Checks every branch of the Tasks bridge's mappings between Kotlin and Swift values with Kotlin values built here.
/// Both modules declare most of these type names, so each is qualified with its module.
final class SharedTasksMappingTests: XCTestCase {

    // MARK: - Tasks state
    @MainActor
    func testTasksMapsEveryPhase() {
        XCTAssertEqual(Tasks.state(tasksState(.loading)).phase, .loading)
        XCTAssertEqual(Tasks.state(tasksState(.content)).phase, .content)
        XCTAssertEqual(Tasks.state(tasksState(.error, failure: .unauthorized)).phase, .failure(.unauthorized))
        XCTAssertEqual(Tasks.state(tasksState(.error)).phase, .failure(nil))
    }

    @MainActor
    func testTasksMapsTheFilterTheCountsAndTheNotice() {
        let state = Tasks.state(
            tasksState(
                .content,
                tab: .planned,
                hideDone: true,
                areaId: "a1",
                projectId: "p1",
                flaggedOnly: true,
                openCount: 4,
                matchesNothing: true,
                notice: .rejected
            )
        )
        XCTAssertEqual(state.tab, .planned)
        XCTAssertTrue(state.hideDone)
        XCTAssertEqual(state.areaId, "a1")
        XCTAssertEqual(state.projectId, "p1")
        XCTAssertTrue(state.flaggedOnly)
        XCTAssertTrue(state.filterActive)
        XCTAssertEqual(state.openCount, 4)
        XCTAssertEqual(state.areaAllCount, 7)
        XCTAssertEqual(state.projectAllCount, 8)
        XCTAssertTrue(state.matchesNothing)
        XCTAssertEqual(state.notice, .rejected)
        let plain = Tasks.state(tasksState(.content))
        XCTAssertFalse(plain.filterActive)
        XCTAssertNil(plain.notice)
    }

    @MainActor
    func testTasksMapsEveryTab() {
        let tabs: [(SharedSDK.TasksTab, CoreKit.TasksTab)] = [(.today, .today), (.planned, .planned), (.all, .all)]
        for (shared, native) in tabs {
            XCTAssertEqual(Tasks.state(tasksState(.content, tab: shared)).tab, native)
            XCTAssertEqual(native.shared, shared)
        }
    }

    @MainActor
    func testTasksMapsEveryGroupKindAndTheRows() {
        let kinds: [(SharedSDK.TaskSectionKind, CoreKit.TaskSectionKind)] = [
            (.late, .late), (.today, .today), (.tomorrow, .tomorrow), (.week, .week), (.later, .later), (.none, .noDate)
        ]
        let groups = kinds.map { SharedSDK.TaskGroup(kind: $0.0, rows: []) }
        let state = Tasks.state(tasksState(.content, groups: groups))
        XCTAssertEqual(state.groups.map(\.kind), kinds.map(\.1))

        let row = SharedSDK.TaskRow(
            id: "t1",
            title: "Odeslat fakturu",
            done: true,
            flagged: true,
            date: "2026-10-16",
            timeFrom: "14:00",
            timeTo: "15:30",
            movedFrom: "2026-10-13",
            projectTitle: "Účetnictví",
            repeat: .daily,
            overdue: true,
            missed: true
        )
        let mapped = Tasks.state(
            tasksState(.content, groups: [SharedSDK.TaskGroup(kind: .today, rows: [row])])
        ).groups[0].rows[0]
        XCTAssertEqual(
            mapped,
            CoreKit.TaskRow(
                id: "t1",
                title: "Odeslat fakturu",
                done: true,
                flagged: true,
                date: "2026-10-16",
                timeFrom: "14:00",
                timeTo: "15:30",
                movedFrom: "2026-10-13",
                projectTitle: "Účetnictví",
                repeats: .daily,
                overdue: true,
                missed: true
            )
        )
    }

    @MainActor
    func testTasksMapsTheFilterOptions() {
        let state = Tasks.state(
            tasksState(
                .content,
                areaOptions: [
                    SharedSDK.TaskFilterOption(id: "a1", title: "Práce", color: "#5856D6", count: 3, areaId: nil)
                ],
                projectOptions: [SharedSDK.TaskFilterOption(id: "p1", title: "iOS", color: nil, count: 2, areaId: "a1")]
            )
        )
        XCTAssertEqual(state.areaOptions, [CoreKit.TaskFilterOption(id: "a1", title: "Práce", color: "#5856D6", count: 3)])
        XCTAssertEqual(state.projectOptions, [CoreKit.TaskFilterOption(id: "p1", title: "iOS", count: 2, areaId: "a1")])
    }

    // MARK: - Tasks actions and effects
    @MainActor
    func testTasksMapsEveryAction() throws {
        let select = try XCTUnwrap(Tasks.action(.selectTab(.all)) as? SharedSDK.TasksActionSelectTab)
        XCTAssertEqual(select.tab, .all)
        XCTAssertTrue(Tasks.action(.toggleHideDone) is SharedSDK.TasksActionToggleHideDone)
        let area = try XCTUnwrap(Tasks.action(.setArea("a1")) as? SharedSDK.TasksActionSetArea)
        XCTAssertEqual(area.areaId, "a1")
        let noArea = try XCTUnwrap(Tasks.action(.setArea(nil)) as? SharedSDK.TasksActionSetArea)
        XCTAssertNil(noArea.areaId)
        let project = try XCTUnwrap(Tasks.action(.setProject("p1")) as? SharedSDK.TasksActionSetProject)
        XCTAssertEqual(project.projectId, "p1")
        let flagged = try XCTUnwrap(
            Tasks.action(.setFlaggedOnly(true)) as? SharedSDK.TasksActionSetFlaggedOnly
        )
        XCTAssertTrue(flagged.flaggedOnly)
        XCTAssertTrue(Tasks.action(.clearFilters) is SharedSDK.TasksActionClearFilters)
        XCTAssertTrue(Tasks.action(.retry) is SharedSDK.TasksActionRetry)
        XCTAssertTrue(Tasks.action(.refresh) is SharedSDK.TasksActionRefresh)
        let toggle = try XCTUnwrap(Tasks.action(.toggleDone(taskId: "t1")) as? SharedSDK.TasksActionToggleDone)
        XCTAssertEqual(toggle.taskId, "t1")
        let rename = try XCTUnwrap(
            Tasks.action(.rename(taskId: "t1", title: "Nový")) as? SharedSDK.TasksActionRename
        )
        XCTAssertEqual([rename.taskId, rename.title], ["t1", "Nový"])
        let add = try XCTUnwrap(Tasks.action(.add(title: "Nový")) as? SharedSDK.TasksActionAdd)
        XCTAssertEqual(add.title, "Nový")
        let open = try XCTUnwrap(Tasks.action(.openDetails(taskId: "t1")) as? SharedSDK.TasksActionOpenDetails)
        XCTAssertEqual(open.taskId, "t1")
        XCTAssertTrue(Tasks.action(.dismissNotice) is SharedSDK.TasksActionDismissNotice)
    }

    @MainActor
    func testTasksMapsEachEffect() {
        XCTAssertEqual(
            Tasks.effect(SharedSDK.TasksEffectOpenDetails(taskId: "t1")),
            .openDetails(taskId: "t1")
        )
    }

    // MARK: - Today
    func testIsoDayWritesAndReadsDaysInTheCalendarOfTheDevice() throws {
        let date = try XCTUnwrap(IsoDay.date(from: "2026-10-16"))
        XCTAssertEqual(IsoDay.string(from: date), "2026-10-16")
        XCTAssertEqual(IsoDay.string(from: try XCTUnwrap(IsoDay.date(from: "2024-02-29"))), "2024-02-29")
        XCTAssertNil(IsoDay.date(from: "tomorrow"))
        XCTAssertNil(IsoDay.date(from: "2026-10"))
        XCTAssertEqual(IsoDay.today().count, 10)
    }
}

// MARK: - Builders
private extension SharedTasksMappingTests {

    func tasksState(
        _ phase: SharedSDK.TasksPhase,
        failure: SharedSDK.FailureKind? = nil,
        tab: SharedSDK.TasksTab = .today,
        hideDone: Bool = false,
        areaId: String? = nil,
        projectId: String? = nil,
        flaggedOnly: Bool = false,
        groups: [SharedSDK.TaskGroup] = [],
        openCount: Int32 = 0,
        areaOptions: [SharedSDK.TaskFilterOption] = [],
        projectOptions: [SharedSDK.TaskFilterOption] = [],
        matchesNothing: Bool = false,
        notice: SharedSDK.FailureKind? = nil
    ) -> SharedSDK.TasksState {
        SharedSDK.TasksState(
            phase: phase,
            failure: failure,
            tab: tab,
            hideDone: hideDone,
            areaId: areaId,
            projectId: projectId,
            flaggedOnly: flaggedOnly,
            groups: groups,
            openCount: openCount,
            areaOptions: areaOptions,
            projectOptions: projectOptions,
            areaAllCount: 7,
            projectAllCount: 8,
            matchesNothing: matchesNothing,
            notice: notice
        )
    }
}
