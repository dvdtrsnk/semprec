import CoreKit
import XCTest

@testable import AreasFeature

final class AreaViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedAreaScreenModel(state: AreaState())
        let viewModel = AreaViewModel(areaId: "a1", model: model, router: RouterSpy())
        XCTAssertEqual(viewModel.state.phase, .loading)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.publish(AreaState(phase: .content, name: "Work", tasksOpen: 7))
        try await eventually { viewModel.state.name == "Work" }
        XCTAssertEqual(viewModel.state.tasksOpen, 7)
    }

    @MainActor
    func testIntentsAreForwardedToTheModel() {
        let model = ScriptedAreaScreenModel(state: AreaState())
        let viewModel = AreaViewModel(areaId: "a1", model: model, router: RouterSpy())
        viewModel.retry()
        viewModel.openTasks(todayOnly: true)
        viewModel.open(AreaUpcomingItem(
            kind: .task,
            id: "t1",
            title: "T",
            date: nil,
            timeFrom: nil,
            timeTo: nil,
            projectTitle: nil,
            projectColor: nil
        ))
        viewModel.open(
            AreaRelatedItem(databaseId: "d1", databaseKey: "files", name: "Files", icon: nil, color: nil, count: 3)
        )
        viewModel.openNotes()
        viewModel.setActive(false)
        viewModel.dismissFailure()
        XCTAssertEqual(
            model.actions,
            [
                .retry, .openTasks(
                    todayOnly: true
                ), .openUpcoming(id: "t1"), .openRelated(databaseId: "d1"), .openNotes,
                .setActive(false), .dismissFailure
            ]
        )
    }

    @MainActor
    func testEveryEffectTheModelRaisesReachesTheRouterOnceWithTheIdOfTheArea() async throws {
        let router = RouterSpy()
        let model = ScriptedAreaScreenModel(state: AreaState())
        let viewModel = AreaViewModel(areaId: "a1", model: model, router: router)
        // Raised before anyone observes: it waits for the observer.
        model.emit(.openTasks(todayOnly: true))
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.openDetails(kind: .event, id: "e1"))
        model.emit(.openCollection(.matching(databaseKey: "files", databaseId: "d1", filterJson: "{}")))
        model.emit(.openMail)
        model.emit(.openNotes)
        try await eventually { router.calls.count == 5 }
        XCTAssertEqual(
            router.calls,
            [
                "tasks:a1:true", "details:event:e1", "collection:matching(databaseKey: Optional(\"files\"), "
                    + "databaseId: Optional(\"d1\"), filterJson: \"{}\")",
                "mail:a1", "notes:a1"
            ]
        )
    }

    @MainActor
    func testARefreshReturnsOnceTheAreaIsNotLoadingAnymore() async throws {
        let model = ScriptedAreaScreenModel(state: AreaState(phase: .content))
        let viewModel = AreaViewModel(areaId: "a1", model: model, router: RouterSpy())
        let finished = Received<Bool>()
        let refresh = Task { @MainActor in
            await viewModel.refresh()
            finished.values.append(true)
        }
        defer { refresh.cancel() }
        try await eventually { model.actions == [.refresh] }
        try await eventually { finished.values == [true] }
        XCTAssertEqual(finished.values, [true], "The content stays on screen, so the refresh ends without new state")
        model.publish(AreaState(phase: .loading))
        let second = Task { @MainActor in
            await viewModel.refresh()
            finished.values.append(true)
        }
        defer { second.cancel() }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(finished.values, [true], "A refresh without content lasts while the area loads")
        model.publish(AreaState(phase: .content))
        try await eventually { finished.values == [true, true] }
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedAreaScreenModel?
        var viewModel: AreaViewModel?
        do {
            let model = ScriptedAreaScreenModel(state: AreaState())
            weakModel = model
            viewModel = AreaViewModel(areaId: "a1", model: model, router: RouterSpy())
        }
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel)
        XCTAssertNil(viewModel)
    }

    // MARK: - Words
    func testTheWhenOfAnUpcomingItemNamesTheDayAndTheTimes() throws {
        let calendar = Calendar(identifier: .gregorian)
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 21, hour: 9)))
        let dates = AreaDate(now: now, calendar: calendar, locale: Locale(identifier: "en_US"))
        XCTAssertEqual(dates.when(date: "2026-10-21", timeFrom: "14:00", timeTo: "15:30"), "Today 14:00\u{2013}15:30")
        XCTAssertEqual(dates.when(date: "2026-10-22", timeFrom: nil, timeTo: nil), "Tomorrow")
        XCTAssertEqual(dates.when(date: "2026-10-20", timeFrom: "7:00", timeTo: nil), "Yesterday 7:00")
        XCTAssertEqual(dates.when(date: nil, timeFrom: "9:00", timeTo: nil), "9:00")
        XCTAssertNil(dates.when(date: nil, timeFrom: nil, timeTo: nil))
        XCTAssertNotNil(dates.when(date: "2026-11-03", timeFrom: nil, timeTo: nil))
        XCTAssertNil(dates.text(iso: "soon"))
    }

    func testOnlyADayBeforeTodayIsLate() throws {
        let calendar = Calendar(identifier: .gregorian)
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 21, hour: 9)))
        let dates = AreaDate(now: now, calendar: calendar, locale: Locale(identifier: "en_US"))
        XCTAssertTrue(dates.isLate(iso: "2026-10-20"))
        XCTAssertFalse(dates.isLate(iso: "2026-10-21"))
        XCTAssertFalse(dates.isLate(iso: "2026-10-22"))
        XCTAssertFalse(dates.isLate(iso: nil))
        XCTAssertFalse(dates.isLate(iso: "soon"))
    }

    func testSymbolsFallBackToWhatTheRowStandsFor() {
        XCTAssertEqual(AreaSymbols.area(icon: "briefcase"), "briefcase")
        XCTAssertEqual(AreaSymbols.area(icon: "unknown"), AreaSymbols.areaFallback)
        XCTAssertEqual(AreaSymbols.area(icon: nil), AreaSymbols.areaFallback)
        XCTAssertEqual(AreaSymbols.collection(icon: "film", databaseKey: nil), "film")
        XCTAssertEqual(AreaSymbols.collection(icon: nil, databaseKey: "threads"), "envelope")
        XCTAssertEqual(AreaSymbols.collection(icon: "unknown", databaseKey: "nothing"), AreaSymbols.collectionFallback)
    }

    // MARK: - Helpers
    @MainActor
    private func eventually(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("The condition did not hold in time")
    }
}

// MARK: - Spies
/// Values a test task received on the main actor.
@MainActor
final class Received<Value> {

    // MARK: - Properties
    var values: [Value] = []
}

@MainActor
final class RouterSpy: AreasRouting {

    // MARK: - Properties
    private(set) var calls: [String] = []

    // MARK: - Protocol conformance
    func showTasks(areaId: String, todayOnly: Bool) {
        calls.append("tasks:\(areaId):\(todayOnly)")
    }

    func showDetails(kind: ItemKind, id: String) {
        calls.append("details:\(kind):\(id)")
    }

    func showCollection(_ target: CollectionTarget) {
        calls.append("collection:\(target)")
    }

    func showMail(areaId: String) {
        calls.append("mail:\(areaId)")
    }

    func showNotes(areaId: String) {
        calls.append("notes:\(areaId)")
    }
}
