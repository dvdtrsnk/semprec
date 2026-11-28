import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every action, effect and shared value the diary bridges map, with Kotlin values built here.
@MainActor
final class SharedJournalActionMappingTests: XCTestCase {

    // MARK: - Diary
    func testActionsWithoutArgumentsMapToTheirKotlinObjects() {
        XCTAssertTrue(SharedJournalScreenModel.action(.retry) is SharedSDK.JournalActionRetry)
        XCTAssertTrue(SharedJournalScreenModel.action(.goToday) is SharedSDK.JournalActionGoToday)
        XCTAssertTrue(SharedJournalScreenModel.action(.openInbox) is SharedSDK.JournalActionOpenInbox)
        XCTAssertTrue(
            SharedJournalScreenModel.action(.closeAttachment) is SharedSDK.JournalActionCloseAttachment
        )
    }

    func testOpeningAnAttachmentCarriesTheEntryAndTheAttachment() throws {
        let open = try XCTUnwrap(
            SharedJournalScreenModel.action(.openAttachment(entryId: "i1", attachmentId: "a1"))
                as? SharedSDK.JournalActionOpenAttachment
        )
        XCTAssertEqual(open.entryId, "i1")
        XCTAssertEqual(open.attachmentId, "a1")
    }

    func testTheStateCarriesTheAttachmentPreview() {
        let preview = SharedSDK.AttachmentPreviewState(attachmentId: "a1", phase: .opening, path: nil, failure: nil)
        let state = SharedJournalScreenModel.state(JournalKotlin.state(.content, attachment: preview))
        XCTAssertEqual(state.attachment, AttachmentPreview(attachmentId: "a1", phase: .opening))
        XCTAssertNil(SharedJournalScreenModel.state(JournalKotlin.state(.content)).attachment)
    }

    func testNavigationActionsCarryTheirArguments() throws {
        let select = try XCTUnwrap(
            SharedJournalScreenModel.action(.select(kind: .quarter, start: "2026-10-01"))
                as? SharedSDK.JournalActionSelect
        )
        XCTAssertEqual(select.kind, .quarter)
        XCTAssertEqual(select.start, "2026-10-01")
        let event = try XCTUnwrap(
            SharedJournalScreenModel.action(.openEvent(id: "e")) as? SharedSDK.JournalActionOpenEvent
        )
        XCTAssertEqual(event.id, "e")
        let around = try XCTUnwrap(
            SharedJournalScreenModel.action(.showAxisAround(day: "2029-03-10"))
                as? SharedSDK.JournalActionShowAxisAround
        )
        XCTAssertEqual(around.day, "2029-03-10")
        let turn = try XCTUnwrap(SharedJournalScreenModel.action(.turn(steps: -2)) as? SharedSDK.JournalActionTurn)
        XCTAssertEqual(turn.steps, -2)
    }

    func testEffectsMapEveryCase() {
        XCTAssertEqual(
            SharedJournalScreenModel.effect(SharedSDK.JournalEffectOpenEvent(id: "e")),
            .openEvent(id: "e")
        )
        XCTAssertEqual(SharedJournalScreenModel.effect(SharedSDK.JournalEffectOpenInbox.shared), .openInbox)
    }

    // MARK: - Values
    func testPeriodKindsMapBothWays() {
        let pairs: [(SharedSDK.JournalPeriodKind, CoreKit.JournalPeriodKind)] = [
            (.year, .year), (.quarter, .quarter), (.month, .month), (.week, .week), (.day, .day)
        ]
        for (shared, native) in pairs {
            XCTAssertEqual(CoreKit.JournalPeriodKind(shared), native)
            XCTAssertEqual(native.shared, shared)
        }
    }

    func testBlockKindsMapFromKotlin() {
        let pairs: [(SharedSDK.JournalBlockKind, CoreKit.JournalBlockKind)] = [
            (.text, .text), (.h1, .heading1), (.h2, .heading2), (.h3, .heading3), (.bullet, .bullet),
            (.number, .number), (.todo, .todo), (.quote, .quote), (.page, .page)
        ]
        for (shared, native) in pairs {
            XCTAssertEqual(CoreKit.JournalBlockKind(shared), native)
        }
    }

    func testInboxStatusesMapEveryCase() {
        let pairs: [(SharedSDK.JournalInboxStatus, CoreKit.JournalInboxStatus)] = [
            (.none, .none), (.waiting, .waiting), (.pending, .pending), (.failed, .failed),
            (.needsClarification, .needsClarification),
            (.proposed, .proposed), (.confirmed, .confirmed), (.rejected, .rejected), (.invalid, .invalid)
        ]
        for (shared, native) in pairs { XCTAssertEqual(CoreKit.JournalInboxStatus(shared), native) }
    }

    func testBlockPlainTextJoinsTheRuns() {
        let runs = [CoreKit.JournalRun(text: "a "), CoreKit.JournalRun(text: "b", bold: true)]
        let block = CoreKit.JournalBlock(index: 0, kind: .text, runs: runs)
        XCTAssertEqual(block.plainText, "a b")
        XCTAssertEqual(block.id, 0)
    }
}
