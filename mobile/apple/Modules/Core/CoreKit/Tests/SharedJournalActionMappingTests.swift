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
        XCTAssertTrue(SharedJournalScreenModel.action(.dismissProblem) is SharedSDK.JournalActionDismissProblem)
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
        let page = try XCTUnwrap(
            SharedJournalScreenModel.action(.openPage(pageId: "p", title: "T")) as? SharedSDK.JournalActionOpenPage
        )
        XCTAssertEqual([page.pageId, page.title], ["p", "T"])
    }

    func testEditActionsCarryThePageAndTheChange() throws {
        let ref = CoreKit.JournalPageRef(kind: .week, period: "2026-W42")
        let text = try XCTUnwrap(
            SharedJournalScreenModel.action(.setText(page: ref, index: 3, text: "x"))
                as? SharedSDK.JournalActionSetText
        )
        XCTAssertEqual([text.page.period, text.text], ["2026-W42", "x"])
        XCTAssertEqual(text.index, 3)
        XCTAssertEqual(text.page.kind, .week)
        let toggle = try XCTUnwrap(
            SharedJournalScreenModel.action(.toggleDone(page: ref, index: 4)) as? SharedSDK.JournalActionToggleDone
        )
        XCTAssertEqual(toggle.index, 4)
        let add = try XCTUnwrap(
            SharedJournalScreenModel.action(.addBlock(page: ref, kind: .quote, text: "q"))
                as? SharedSDK.JournalActionAddBlock
        )
        XCTAssertEqual(add.kind, .quote)
        XCTAssertEqual(add.text, "q")
    }

    func testEffectsMapEveryCase() {
        XCTAssertEqual(
            SharedJournalScreenModel.effect(SharedSDK.JournalEffectOpenEvent(id: "e")),
            .openEvent(id: "e")
        )
        XCTAssertEqual(SharedJournalScreenModel.effect(SharedSDK.JournalEffectOpenInbox.shared), .openInbox)
        XCTAssertEqual(
            SharedJournalScreenModel.effect(SharedSDK.JournalEffectOpenPage(pageId: "p", title: "T")),
            .openPage(pageId: "p", title: "T")
        )
    }

    // MARK: - Subpage
    func testSubpageStateMapsEveryPhaseAndItsBlocks() {
        let block = JournalKotlin.block(
            index: 0, kind: .page, runs: [JournalKotlin.run("Deeper")], pageId: "jv2"
        )
        let content = SharedJournalSubpageScreenModel.state(
            JournalKotlin.subpageState(.content, blocks: [block], saving: true)
        )
        XCTAssertEqual(content.phase, .content)
        XCTAssertTrue(content.saving)
        XCTAssertEqual(content.blocks.first?.kind, .page)
        XCTAssertEqual(content.blocks.first?.pageId, "jv2")
        XCTAssertEqual(content.blocks.first?.plainText, "Deeper")
        XCTAssertEqual(SharedJournalSubpageScreenModel.state(JournalKotlin.subpageState(.loading)).phase, .loading)
        XCTAssertEqual(
            SharedJournalSubpageScreenModel.state(JournalKotlin.subpageState(.error, failure: .notFound)).phase,
            .failure(.notFound)
        )
        XCTAssertEqual(
            SharedJournalSubpageScreenModel.state(JournalKotlin.subpageState(.error)).phase,
            .failure(nil)
        )
    }

    func testSubpageEditProblemsMapWithTheirFailure() {
        XCTAssertEqual(
            SharedJournalSubpageScreenModel.state(JournalKotlin.subpageState(.content, editProblem: .stale))
                .editProblem,
            .stale
        )
        XCTAssertEqual(
            SharedJournalSubpageScreenModel.state(
                JournalKotlin.subpageState(.content, editProblem: .failed, editFailure: .unavailable)
            ).editProblem,
            .failed(.unavailable)
        )
    }

    func testSubpageActionsAndEffectsMapEveryCase() throws {
        XCTAssertTrue(SharedJournalSubpageScreenModel.action(.retry) is SharedSDK.JournalSubpageActionRetry)
        XCTAssertTrue(
            SharedJournalSubpageScreenModel.action(.dismissProblem) is SharedSDK.JournalSubpageActionDismissProblem
        )
        let text = try XCTUnwrap(
            SharedJournalSubpageScreenModel.action(.setText(index: 1, text: "x"))
                as? SharedSDK.JournalSubpageActionSetText
        )
        XCTAssertEqual(text.index, 1)
        XCTAssertEqual(text.text, "x")
        let toggle = try XCTUnwrap(
            SharedJournalSubpageScreenModel.action(.toggleDone(index: 2)) as? SharedSDK.JournalSubpageActionToggleDone
        )
        XCTAssertEqual(toggle.index, 2)
        let add = try XCTUnwrap(
            SharedJournalSubpageScreenModel.action(.addBlock(kind: .heading3, text: "h"))
                as? SharedSDK.JournalSubpageActionAddBlock
        )
        XCTAssertEqual(add.kind, .h3)
        let page = try XCTUnwrap(
            SharedJournalSubpageScreenModel.action(.openPage(pageId: "p", title: "T"))
                as? SharedSDK.JournalSubpageActionOpenPage
        )
        XCTAssertEqual([page.pageId, page.title], ["p", "T"])
        XCTAssertEqual(
            SharedJournalSubpageScreenModel.effect(SharedSDK.JournalSubpageEffectOpenPage(pageId: "p", title: "T")),
            .openPage(pageId: "p", title: "T")
        )
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

    func testBlockKindsMapBothWays() {
        let pairs: [(SharedSDK.JournalBlockKind, CoreKit.JournalBlockKind)] = [
            (.text, .text), (.h1, .heading1), (.h2, .heading2), (.h3, .heading3), (.bullet, .bullet),
            (.number, .number), (.todo, .todo), (.quote, .quote), (.page, .page)
        ]
        for (shared, native) in pairs {
            XCTAssertEqual(CoreKit.JournalBlockKind(shared), native)
            XCTAssertEqual(native.shared, shared)
        }
    }

    func testInboxStatusesMapEveryCase() {
        let pairs: [(SharedSDK.JournalInboxStatus, CoreKit.JournalInboxStatus)] = [
            (.none, .none), (.pending, .pending), (.failed, .failed), (.needsClarification, .needsClarification),
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
