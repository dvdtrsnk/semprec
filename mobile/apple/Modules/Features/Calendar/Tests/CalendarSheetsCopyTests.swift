import CoreKit
import XCTest

@testable import CalendarFeature

/// The copy the sheets derive from their state. The texts depend on the test host's language, so the tests check
/// which text is chosen and what it carries rather than its wording.
final class CalendarSheetsCopyTests: XCTestCase {

    // MARK: - Invitations
    func testAnInviteNamesItsOrganizerAndShowsItsPlace() {
        let item = InvitationItem(id: "i1", title: "Review", place: "Karlín", organizerName: "Petr Novák")
        let anonymous = InvitationItem(id: "i2", title: "Review", place: "Karlín")
        XCTAssertTrue(item.kicker.contains("Petr Novák"))
        XCTAssertNotEqual(anonymous.kicker, item.kicker)
        XCTAssertFalse(anonymous.kicker.isEmpty)
        XCTAssertEqual(item.meta, "Karlín")
    }

    func testANoticeShowsWhoAddedItAndThePlace() {
        let notice = InvitationItem(
            id: "n1", kind: .sharedCalendarNotice, title: "Meeting", place: "School", organizerName: "Jana"
        )
        let invite = InvitationItem(id: "i1", title: "Meeting", organizerName: "Jana")
        XCTAssertEqual(notice.meta, "Jana · School")
        XCTAssertFalse(notice.kicker.contains("Jana"))
        XCTAssertNotEqual(notice.kicker, invite.kicker)
    }

    func testAnInvitationWithoutPlaceOrOrganizerHasNoMeta() {
        XCTAssertNil(InvitationItem(id: "i1", title: "Review", place: "", organizerName: "Petr").meta)
        XCTAssertNil(InvitationItem(id: "n1", kind: .sharedCalendarNotice, title: "Meeting").meta)
    }

    func testOnlyAnAnsweredInvitationCarriesAStatus() {
        XCTAssertNil(InvitationItem(id: "i1", title: "Review").statusLabel)
        let answered: [InvitationItemStatus] = [.accepted, .tentative, .declined, .acknowledged, .cancelled]
        let labels = answered.compactMap { InvitationItem(id: "i1", status: $0, title: "Review").statusLabel }
        XCTAssertEqual(labels.count, answered.count)
        XCTAssertTrue(labels.allSatisfy { !$0.isEmpty })
    }

    func testAnInvitationWithoutAStartHasNoTime() {
        XCTAssertNil(InvitationItem(id: "i1", title: "Review").when)
        XCTAssertNotNil(InvitationItem(id: "i1", title: "Review", startsAt: "2026-10-23T17:00:00Z").when)
    }

    // MARK: - Calendars
    func testTheDeleteMessageNamesWhatTheDeleteTakesWithIt() {
        let empty = CalendarImpact(calendarId: "c", eventCount: 0, recipientCount: 0, cancellationCount: 0)
        let events = CalendarImpact(calendarId: "c", eventCount: 12, recipientCount: 0, cancellationCount: 0)
        let sent = CalendarImpact(calendarId: "c", eventCount: 12, recipientCount: 4, cancellationCount: 6)
        XCTAssertFalse(empty.message.contains { $0.isNumber })
        XCTAssertTrue(events.message.contains("12"))
        XCTAssertTrue(["12", "4", "6"].allSatisfy(sent.message.contains))
        XCTAssertEqual(Set([empty.message, events.message, sent.message]).count, 3)
    }

    func testEverySwatchOfTheSharedLayerHasAName() {
        for swatch in CalendarListState.previewSwatches {
            XCTAssertNotEqual(swatch.name, swatch.hex, "\(swatch.key) has no name")
        }
        XCTAssertEqual(CalendarSwatch(key: "chartreuse", hex: "#7FFF00").name, "#7FFF00")
    }

    func testASwatchMatchesItsColourInAnyCase() {
        let swatch = CalendarSwatch(key: "blue", hex: "#007AFF")
        XCTAssertTrue(swatch.matches("#007aff"))
        XCTAssertFalse(swatch.matches("#007AFE"))
    }

    func testCalendarsAlldotsFillsExplainWhatFillsThem() {
        let keys = ["tasks", "birthdays", "sleep", "holidaysCz"]
        let subtitles = keys.compactMap { CalendarRow(id: $0, name: $0, color: "#000000", systemKey: $0).subtitle }
        XCTAssertEqual(Set(subtitles).count, keys.count)
        XCTAssertNil(CalendarRow(id: "work", name: "Work", color: "#000000").subtitle)
    }

    func testOnlyTheSleepCalendarOpensTheSleepPlan() {
        XCTAssertTrue(CalendarRow(id: "s", name: "Sleep", color: "#000000", systemKey: "sleep").isSleep)
        XCTAssertFalse(CalendarRow(id: "t", name: "Tasks", color: "#000000", systemKey: "tasks").isSleep)
    }

    func testTheDetailHintFollowsWhereTheCalendarComesFrom() {
        let own = CalendarRow(id: "w", name: "Work", color: "#000000")
        let tasks = CalendarRow(id: "t", name: "Tasks", color: "#000000", group: .system, systemKey: "tasks")
        let birthdays = CalendarRow(id: "b", name: "B", color: "#000000", group: .system, systemKey: "birthdays")
        let subscription = CalendarRow(id: "h", name: "H", color: "#000000", group: .subscription)
        let sleep = CalendarRow(id: "s", name: "Sleep", color: "#000000", group: .system, systemKey: "sleep")
        let account = CalendarRow(id: "g", name: "G", color: "#000000", group: .account)
        let readOnly = CalendarRow(id: "r", name: "R", color: "#000000", group: .account, readOnly: true)
        let hints = [own.hint, tasks.hint, birthdays.hint, subscription.hint, account.hint, readOnly.hint]
        XCTAssertEqual(Set(hints).count, 6)
        XCTAssertEqual(sleep.hint, own.hint)
    }

    func testAnAccountCalendarRenamedHereNamesItsProviderName() throws {
        let renamed = CalendarRow(id: "g", name: "Rodina", color: "#000000", group: .account, remoteName: "Family")
        XCTAssertTrue(try XCTUnwrap(renamed.providerName).contains("Family"))
        let asAtProvider = CalendarRow(id: "g", name: "Family", color: "#000000", group: .account, remoteName: "Family")
        XCTAssertNil(asAtProvider.providerName)
        XCTAssertNil(CalendarRow(id: "w", name: "Work", color: "#000000", remoteName: "Job").providerName)
    }

    func testEveryAccountStatusHasItsOwnTextAndOnlyProblemsAskForAttention() {
        let statuses: [InternetServiceStatus] = [
            .off, .pending, .syncing, .ok, .error, .needsReauthorization, .needsConsent
        ]
        XCTAssertEqual(Set(statuses.map(\.calendarsText)).count, statuses.count)
        XCTAssertEqual(statuses.filter(\.needsAttention), [.error, .needsReauthorization, .needsConsent])
    }

    // MARK: - Failures
    func testEveryFailureHasItsOwnMessage() {
        let kinds: [FailureKind?] = [.unavailable, .invalidData, .unauthorized, .notFound, .rejected, nil]
        let messages = kinds.map(FailureKind.sheetMessage(for:))
        XCTAssertEqual(Set(messages).count, kinds.count)
        XCTAssertFalse(messages.contains { $0.hasPrefix("sheets.") }, "A message must come from the Sheets catalog")
    }
}
