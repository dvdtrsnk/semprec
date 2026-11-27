import CoreKit
import XCTest

@testable import SempFeature

/// How the feature writes what the server sends: instants, history groups, Markdown lines, approval descriptions and
/// where the bubble rests.
final class SempFormatTests: XCTestCase {

    private let locale = Locale(identifier: "en_US")
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return calendar
    }

    // MARK: - Time
    func testAnInstantWithMicrosecondsIsRead() {
        let date = SempTime.date("2026-10-21T13:24:06.123456Z")
        XCTAssertEqual(date?.timeIntervalSince1970 ?? 0, 1_792_589_046.123, accuracy: 0.01)
        XCTAssertNotNil(SempTime.date("2026-10-21T13:24:06Z"))
        XCTAssertNil(SempTime.date("yesterday"))
    }

    func testTheClockTimeIsInTheGivenZone() {
        let zone = TimeZone(identifier: "UTC") ?? .gmt
        let clock = SempTime.clock("2026-10-21T13:24:06.000Z", locale: locale, timeZone: zone)
        XCTAssertEqual(clock?.replacing("\u{202F}", with: " "), "1:24 PM")
        XCTAssertNil(SempTime.clock("nope"))
    }

    func testDurationsAreWrittenInSecondsAndMinutes() {
        XCTAssertEqual(SempTime.duration(milliseconds: 4_100, locale: locale), "4.1 s")
        XCTAssertEqual(SempTime.duration(milliseconds: 400, locale: locale), "0.4 s")
        XCTAssertEqual(SempTime.duration(milliseconds: 125_000, locale: locale), "2 min 5 s")
    }

    func testTheListLabelIsTheClockTodayTheWeekdayThisWeekAndTheDateBefore() throws {
        let now = try XCTUnwrap(SempTime.date("2026-10-21T15:00:00Z"))
        let today = SempTime.listLabel("2026-10-21T13:24:00Z", now: now, calendar: calendar, locale: locale)
        XCTAssertEqual(today?.replacing("\u{202F}", with: " "), "1:24 PM")
        XCTAssertEqual(SempTime.listLabel("2026-10-19T13:24:00Z", now: now, calendar: calendar, locale: locale), "Mon")
        XCTAssertEqual(SempTime.listLabel("2026-09-03T13:24:00Z", now: now, calendar: calendar, locale: locale), "9/3")
    }

    // MARK: - Groups
    func testTheHistoryIsGroupedByHowLongAgoItWas() throws {
        let now = try XCTUnwrap(SempTime.date("2026-10-21T15:00:00Z"))
        func row(_ id: String, _ time: String) -> SempChatRow {
            SempChatRow(id: id, type: .chat, title: id, lastActivityAt: time)
        }
        let groups = SempChatGroups.group(
            [
                row("a", "2026-10-21T13:00:00Z"),
                row("b", "2026-10-21T08:00:00Z"),
                row("c", "2026-10-20T20:00:00Z"),
                row("d", "2026-10-16T10:00:00Z"),
                row("e", "2026-09-28T10:00:00Z"),
                row("f", "2026-09-03T10:00:00Z"),
                row("g", "broken")
            ],
            now: now,
            calendar: calendar
        )

        let september = try monthStart(2026, 9)
        XCTAssertEqual(groups.map(\.title).prefix(4), [.today, .yesterday, .previousWeek, .month(september)])
        XCTAssertEqual(groups.map { $0.rows.map(\.id) }.prefix(4), [["a", "b"], ["c"], ["d"], ["e", "f"]])
        XCTAssertEqual(groups.last?.rows.map(\.id), ["g"])
        XCTAssertEqual(Set(groups.map(\.id)).count, groups.count)
    }

    private func monthStart(_ year: Int, _ month: Int) throws -> Date {
        try XCTUnwrap(calendar.date(from: DateComponents(year: year, month: month, day: 1)))
    }

    // MARK: - Markdown
    func testMarkdownIsSplitIntoParagraphsBulletsAndNumberedLines() {
        XCTAssertEqual(
            SempMarkdownBlock.parse("Today:\n\n- **14:00** a\n* call\n\u{2022} mail\n1. first\n2) second\n## Title"),
            [
                .paragraph("Today:"),
                .bullet("**14:00** a"),
                .bullet("call"),
                .bullet("mail"),
                .numbered(1, "first"),
                .numbered(2, "second"),
                .heading("Title")
            ]
        )
        XCTAssertEqual(SempMarkdownBlock.parse("   \n  "), [])
    }

    // MARK: - Approvals
    func testAnApprovalIsDescribedFromItsTemplateAndNames() {
        let item = SempApprovalItem(
            id: "a",
            descriptionKey: "approval.itemDelete",
            descriptionParams: ["itemName": "Tax return", "databaseName": "Tasks"],
            risk: .irreversible,
            threadTitle: "Plan"
        )
        XCTAssertEqual(item.title, "Delete an item")
        XCTAssertEqual(item.target, "\u{201C}Tax return\u{201D} in the database Tasks")
        XCTAssertEqual(item.riskLabel, "Irreversible")
        XCTAssertEqual(item.sourceLabel, "Chat with Semp \u{00B7} Plan")
    }

    func testARequestWithoutWordingReadsAsItsCall() {
        let item = SempApprovalItem(id: "a", descriptionKey: "approval.somethingNew", callLabel: "mail.send")
        XCTAssertEqual(item.title, "mail.send")
        XCTAssertNil(item.target)
        XCTAssertEqual(SempApprovalItem(id: "b").title, "A request from Semp")
    }

    func testEveryDecisionHasItsOutcomeAndAPendingRequestHasNone() {
        let states: [SempDecisionState: String?] = [
            .pending: nil,
            .approving: "Sending\u{2026}",
            .rejecting: "Sending\u{2026}",
            .queued: "Approved \u{2013} being carried out\u{2026}",
            .executed: "Approved and done",
            .rejected: "Rejected \u{2013} Semp will not do it",
            .conflict: "Not done \u{2013} the data changed meanwhile"
        ]
        for (state, label) in states {
            XCTAssertEqual(SempApprovalItem(id: "a", decision: state).outcomeLabel, label, "\(state)")
        }
        XCTAssertEqual(
            SempApprovalItem(id: "a", decision: .conflict, conflictKey: "approval.conflict.deleted").outcomeLabel,
            "Not done \u{2013} the item was deleted meanwhile"
        )
    }

    // MARK: - Bubble
    func testTheBubbleRestsOnTheNearerEdgeAndSnapsIntoCorners() {
        let placement = SempBubblePlacement(size: CGSize(width: 400, height: 800))
        XCTAssertEqual(placement.x(for: .left), 8)
        XCTAssertEqual(placement.x(for: .right), 332)
        XCTAssertEqual(placement.side(centerX: 100, velocityX: 0), .left)
        XCTAssertEqual(placement.side(centerX: 300, velocityX: 0), .right)
        XCTAssertEqual(placement.side(centerX: 220, velocityX: -1_500), .left)
        XCTAssertEqual(placement.rest(top: 30), 8)
        XCTAssertEqual(placement.rest(top: 700), 732)
        XCTAssertEqual(placement.rest(top: 400.4), 400)
        XCTAssertEqual(placement.rest(top: -50), 8)
        XCTAssertEqual(placement.rest(top: 5_000), 732)
    }

    func testEveryKindOfObjectHasAnIconAndNames() {
        let kinds: [SempTargetKind] = [
            .task, .event, .mail, .inbox, .journal, .project, .person, .company, .file, .note, .recording,
            .finance, .health, .recipe, .book, .movie, .run, .other
        ]
        XCTAssertEqual(Set(kinds.map(\.symbol)).count, kinds.count)
        for kind in kinds {
            XCTAssertFalse(kind.name.hasPrefix("semp."), "\(kind)")
            XCTAssertFalse(kind.nameWith.hasPrefix("semp."), "\(kind)")
        }
    }
}
