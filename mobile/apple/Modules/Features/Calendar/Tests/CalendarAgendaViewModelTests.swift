import CoreKit
import XCTest

@testable import CalendarFeature

final class CalendarAgendaViewModelTests: XCTestCase {

    private let event = CalendarAgendaEntry(id: "e1", kind: .event, title: "Meeting", timeFrom: "14:00")
    private let task = CalendarAgendaEntry(id: "t1", kind: .task, title: "Invoice", allDay: true)

    private var content: CalendarAgendaState {
        CalendarAgendaState(
            phase: .content,
            days: [
                CalendarAgendaDay(day: "2026-11-16", entries: [event]),
                CalendarAgendaDay(day: "2026-11-17", entries: [task])
            ],
            hasMore: true
        )
    }

    @MainActor
    func testEveryIntentIsForwardedToTheModel() {
        let model = ScriptedCalendarAgendaScreenModel(state: content)
        let viewModel = CalendarAgendaViewModel(model: model, router: AgendaRouterSpy())
        viewModel.retry()
        viewModel.loadMore()
        viewModel.open(task)
        XCTAssertEqual(model.actions, [.retry, .loadMore, .open(id: "t1")])
    }

    @MainActor
    func testOpeningAnEntryShowsItsDetailsOnItsDay() async throws {
        let model = ScriptedCalendarAgendaScreenModel(state: content)
        let router = AgendaRouterSpy()
        let viewModel = CalendarAgendaViewModel(model: model, router: router)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.openDetails(kind: .event, id: "e1"))
        model.emit(.openDetails(kind: .task, id: "t1"))
        for _ in 0..<200 where router.calls.count < 2 { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(router.calls, ["details e1 event 2026-11-16", "details t1 task 2026-11-17"])
    }
}

// MARK: - Spies
@MainActor
private final class AgendaRouterSpy: CalendarRouting {

    var calls: [String] = []

    func showDetails(itemId: String, kind: CalendarItemKind, day: String) {
        calls.append("details \(itemId) \(kind == .event ? "event" : "task") \(day)")
    }

    func showCalendars() {}

    func showInvitations() {}

    func showNewItem(day: String) {}

    func showSleepNight(night: String) {}

    func showSleepPlan() {}

    func showAgenda(from day: String) {}
}
