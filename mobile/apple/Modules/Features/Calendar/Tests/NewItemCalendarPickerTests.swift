import CoreKit
import XCTest

@testable import CalendarFeature

/// The calendar picker of the new item sheet over the state a scripted model publishes: a section per source and a
/// row label that names the source of a calendar whose name another calendar has too. The own calendars' title
/// depends on the test host's language, so it is compared with the title the own section gets.
final class NewItemCalendarPickerTests: XCTestCase {

    // MARK: - Properties
    private let icloud = NewItemAccount(id: "m1", name: "iCloud", address: "david@tresnak.cc")
    private let family = NewItemAccount(id: "m2", name: "iCloud", address: "family@icloud.com")

    // MARK: - Tests
    @MainActor
    func testThePickerHasASectionPerSourceWithTheOwnCalendarsFirst() async throws {
        let viewModel = try await observed(
            NewItemState(
                phase: .editing,
                groups: [
                    NewItemCalendarGroup(calendars: [own("personal", "Osobní", .own), own("work", "Práce")]),
                    NewItemCalendarGroup(account: icloud, calendars: [synced("g1", "Osobní", icloud, .accountName)]),
                    NewItemCalendarGroup(account: NewItemAccount(id: "m3", address: "a@b.cz"), calendars: []),
                    NewItemCalendarGroup(account: NewItemAccount(id: "m4", name: "Work"), calendars: []),
                    NewItemCalendarGroup(account: NewItemAccount(id: ""), calendars: [])
                ],
                defaultDay: "2026-10-16"
            )
        )
        let titles = viewModel.state.groups.map(NewItemOptions.title(of:))
        XCTAssertEqual(Array(titles[1...3]), ["iCloud · david@tresnak.cc", "a@b.cz", "Work"])
        XCTAssertFalse(titles[0].isEmpty)
        XCTAssertFalse(titles[4].isEmpty)
        XCTAssertEqual(Set(titles).count, titles.count, "The own and the unnamed sections have titles of their own")
        XCTAssertEqual(viewModel.state.calendars.map(\.id), ["personal", "work", "g1"])
    }

    @MainActor
    func testARowNamesTheSourceOnlyWhenTheNameIsShared() async throws {
        let ownGroup = NewItemCalendarGroup(calendars: [own("personal", "Osobní", .own), own("work", "Práce")])
        let viewModel = try await observed(
            NewItemState(
                phase: .editing,
                groups: [
                    ownGroup,
                    NewItemCalendarGroup(account: icloud, calendars: [
                        synced("g1", "Osobní", icloud, .accountName),
                        synced("g2", "Rodina", icloud, .accountAddress)
                    ]),
                    NewItemCalendarGroup(account: family, calendars: [synced("g3", "Rodina", family, .accountAddress)]),
                    NewItemCalendarGroup(account: NewItemAccount(id: ""), calendars: [
                        synced("x1", "Osobní", NewItemAccount(id: ""), .accountName)
                    ])
                ],
                defaultDay: "2026-10-16"
            )
        )
        let labels = viewModel.state.calendars.map(NewItemOptions.label(of:))
        XCTAssertEqual(labels[0], "Osobní · " + NewItemOptions.title(of: ownGroup))
        XCTAssertEqual(
            Array(labels[1...4]),
            ["Práce", "Osobní · iCloud", "Rodina · david@tresnak.cc", "Rodina · family@icloud.com"]
        )
        XCTAssertTrue(labels[5].hasPrefix("Osobní · "))
        XCTAssertEqual(Set(labels).count, labels.count, "Every calendar offered can be told apart")
    }

    // MARK: - Helpers
    private func own(
        _ id: String,
        _ name: String,
        _ qualifier: NewItemCalendarQualifier = .unqualified
    ) -> NewItemCalendar {
        NewItemCalendar(id: id, name: name, color: "#007AFF", qualifier: qualifier)
    }

    private func synced(
        _ id: String,
        _ name: String,
        _ account: NewItemAccount,
        _ qualifier: NewItemCalendarQualifier
    ) -> NewItemCalendar {
        NewItemCalendar(id: id, name: name, color: "#0B8043", account: account, qualifier: qualifier)
    }

    /// A ViewModel over a scripted model that started loading and then published `state`.
    @MainActor
    private func observed(_ state: NewItemState) async throws -> NewItemViewModel {
        let model = ScriptedNewItemScreenModel(state: NewItemState(phase: .loading, defaultDay: "2026-10-16"))
        let viewModel = NewItemViewModel(model: model)
        let observer = Task { await viewModel.observe() }
        model.publish(state)
        for _ in 0..<500 where viewModel.state != state { try await Task.sleep(for: .milliseconds(10)) }
        observer.cancel()
        XCTAssertEqual(viewModel.state, state)
        return viewModel
    }
}
