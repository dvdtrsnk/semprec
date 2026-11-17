import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the AI usage and trash bridges' mappings between Kotlin and Swift values with Kotlin values
/// built here. Both modules declare most of these type names, so each is qualified with its module.
final class UsageAndTrashMappingTests: XCTestCase {

    // MARK: - AI usage
    @MainActor
    func testAiUsageMapsEveryPhaseAndTheContent() {
        let phases: [
            (SharedSDK.AiUsagePhase, CoreKit.AiUsagePhase)
        ] = [(.loading, .loading), (.content, .content), (.error, .error)]
        for (shared, expected) in phases {
            XCTAssertEqual(SharedAiUsageScreenModel.state(aiUsageState(phase: shared)).phase, expected)
        }
        let state = SharedAiUsageScreenModel.state(
            aiUsageState(
                phase: .content,
                failure: .unavailable,
                periods: [
                    SharedSDK.UsagePeriodWeek.shared,
                    SharedSDK.UsagePeriodAll.shared,
                    SharedSDK.UsagePeriodMonth(month: "2026-10")
                ],
                period: SharedSDK.UsagePeriodMonth(month: "2026-10"),
                picked: KotlinInt(int: 1)
            )
        )
        XCTAssertEqual(state.failure, .unavailable)
        XCTAssertEqual(state.periods, [.week, .all, .month("2026-10")])
        XCTAssertEqual(state.period, .month("2026-10"))
        XCTAssertEqual(state.accountStartedAt, "2026-06-03T08:00:00Z")
        XCTAssertEqual(state.totalUsd, 24.12)
        XCTAssertTrue(state.estimated)
        XCTAssertEqual(state.points, [UsagePointItem(key: "2026-10-20", costUsd: 1.5)])
        XCTAssertEqual(state.picked, 1)
    }

    @MainActor
    func testAiUsageMapsTheModelsTheOperationsAndTheCaps() {
        let state = SharedAiUsageScreenModel.state(aiUsageState(phase: .content))
        XCTAssertEqual(
            state.models,
            [
                UsageModelItem(
                    name: "Claude Sonnet",
                    costUsd: 14,
                    callCount: 820,
                    inputTokens: 3_000_000,
                    outputTokens: 900_000,
                    audioSeconds: nil
                ),
                UsageModelItem(
                    name: "Whisper",
                    costUsd: 4.3,
                    callCount: 3,
                    inputTokens: nil,
                    outputTokens: nil,
                    audioSeconds: 8040.5
                )
            ]
        )
        XCTAssertEqual(
            state.operations,
            [UsageOperationItem(label: "Semp chat", costUsd: 15, share: 0.62, callCount: 900)]
        )
        XCTAssertEqual(state.caps, UsageCaps(dailyUsd: 50, monthlyUsd: nil, exhausted: true))
    }

    @MainActor
    func testAiUsageWithoutCapsOrAPickedBarMapsToNil() {
        let state = SharedAiUsageScreenModel.state(aiUsageState(phase: .content, caps: nil, picked: nil))
        XCTAssertNil(state.caps)
        XCTAssertNil(state.picked)
        XCTAssertNil(state.failure)
    }

    @MainActor
    func testAiUsageMapsEachActionAndEachPeriodBothWays() throws {
        XCTAssertTrue(SharedAiUsageScreenModel.action(.retry) is SharedSDK.AiUsageActionRetry)
        let pick = try XCTUnwrap(SharedAiUsageScreenModel.action(.pickPoint(3)) as? SharedSDK.AiUsageActionPickPoint)
        XCTAssertEqual(pick.index, 3)
        let select = try XCTUnwrap(
            SharedAiUsageScreenModel.action(.selectPeriod(.all)) as? SharedSDK.AiUsageActionSelectPeriod
        )
        XCTAssertTrue(select.period is SharedSDK.UsagePeriodAll)
        for period in [UsagePeriod.week, .all, .month("2026-09")] {
            XCTAssertEqual(SharedAiUsageScreenModel.period(SharedAiUsageScreenModel.sharedPeriod(period)), period)
        }
    }

    // MARK: - Trash
    @MainActor
    func testTrashMapsEveryPhaseAndTab() {
        let phases: [
            (SharedSDK.TrashPhase, CoreKit.TrashPhase)
        ] = [(.loading, .loading), (.content, .content), (.error, .error)]
        for (shared, expected) in phases {
            XCTAssertEqual(SharedTrashScreenModel.state(trashState(phase: shared)).phase, expected)
        }
        for tab in [CoreKit.TrashTab.items, .databases] {
            XCTAssertEqual(SharedTrashScreenModel.tab(SharedTrashScreenModel.sharedTab(tab)), tab)
        }
        XCTAssertEqual(
            SharedTrashScreenModel.state(trashState(phase: .error, failure: .unavailable)).failure,
            .unavailable
        )
    }

    @MainActor
    func testTrashMapsTheRowsTheSelectionAndTheWriteFailure() {
        let state = SharedTrashScreenModel.state(
            trashState(
                phase: .content,
                tab: .databases,
                items: [
                    SharedSDK.TrashItemRow(
                        id: "i1",
                        title: "Zarovka",
                        databaseKey: "tasks",
                        databaseName: "Ukoly",
                        deletedAt: "d",
                        daysLeft: 30
                    )
                ],
                databases: [
                    SharedSDK.TrashDatabaseRow(
                        id: "d1",
                        name: "Recepty",
                        itemCount: 42,
                        archivedAt: "a",
                        daysLeft: KotlinInt(int: 27)
                    ),
                    SharedSDK.TrashDatabaseRow(id: "d2", name: "Napady", itemCount: 0, archivedAt: "b", daysLeft: nil)
                ],
                selected: ["d1"]
            )
        )
        XCTAssertEqual(state.tab, .databases)
        XCTAssertEqual(state.selected, ["d1"])
        XCTAssertEqual(
            state.items,
            [
                TrashItemRow(
                    id: "i1",
                    title: "Zarovka",
                    databaseKey: "tasks",
                    databaseName: "Ukoly",
                    deletedAt: "d",
                    daysLeft: 30
                )
            ]
        )
        XCTAssertEqual(
            state.databases,
            [
                TrashDatabaseRow(id: "d1", name: "Recepty", itemCount: 42, archivedAt: "a", daysLeft: 27),
                TrashDatabaseRow(id: "d2", name: "Napady", itemCount: 0, archivedAt: "b", daysLeft: nil)
            ]
        )
        XCTAssertEqual(state.totalItems, 3)
    }

    @MainActor
    func testTrashMapsTheFlagsAndTheWriteFailure() {
        let state = SharedTrashScreenModel.state(
            trashState(
                phase: .content,
                hasMore: true,
                loadingMore: true,
                selecting: true,
                working: true,
                writeFailure: SharedSDK.Failed(kind: .rejected)
            )
        )
        XCTAssertTrue(state.hasMore)
        XCTAssertTrue(state.loadingMore)
        XCTAssertTrue(state.selecting)
        XCTAssertTrue(state.working)
        XCTAssertEqual(state.writeFailure, Failed(kind: .rejected))
    }

    @MainActor
    func testTrashMapsEachActionAndTheRestoredEffect() throws {
        XCTAssertTrue(SharedTrashScreenModel.action(.retry) is SharedSDK.TrashActionRetry)
        XCTAssertTrue(SharedTrashScreenModel.action(.loadMore) is SharedSDK.TrashActionLoadMore)
        XCTAssertTrue(SharedTrashScreenModel.action(.toggleSelecting) is SharedSDK.TrashActionToggleSelecting)
        XCTAssertTrue(SharedTrashScreenModel.action(.selectAll) is SharedSDK.TrashActionSelectAll)
        XCTAssertTrue(SharedTrashScreenModel.action(.restoreSelected) is SharedSDK.TrashActionRestoreSelected)
        XCTAssertTrue(SharedTrashScreenModel.action(.dismissFailure) is SharedSDK.TrashActionDismissFailure)
        let tab = try XCTUnwrap(
            SharedTrashScreenModel.action(.selectTab(.databases)) as? SharedSDK.TrashActionSelectTab
        )
        XCTAssertEqual(tab.tab, .databases)
        let toggle = try XCTUnwrap(SharedTrashScreenModel.action(.toggle(id: "i1")) as? SharedSDK.TrashActionToggle)
        XCTAssertEqual(toggle.id, "i1")
        let restore = try XCTUnwrap(SharedTrashScreenModel.action(.restore(id: "i2")) as? SharedSDK.TrashActionRestore)
        XCTAssertEqual(restore.id, "i2")
        XCTAssertEqual(
            SharedTrashScreenModel.effect(
                SharedSDK.TrashEffectRestored(restored: 2, refused: 1, databaseName: "Ukoly")
            ),
            .restored(restored: 2, refused: 1, databaseName: "Ukoly")
        )
        XCTAssertEqual(
            SharedTrashScreenModel.effect(SharedSDK.TrashEffectRestored(restored: 1, refused: 0, databaseName: nil)),
            .restored(restored: 1, refused: 0, databaseName: nil)
        )
    }
}

// MARK: - Kotlin values
private func aiUsageState(
    phase: SharedSDK.AiUsagePhase,
    failure: SharedSDK.FailureKind? = nil,
    periods: [any SharedSDK.UsagePeriod] = [],
    period: any SharedSDK.UsagePeriod = SharedSDK.UsagePeriodWeek.shared,
    caps: SharedSDK.UsageCaps? = SharedSDK.UsageCaps(
        dailyUsd: KotlinDouble(double: 50),
        monthlyUsd: nil,
        exhausted: true
    ),
    picked: KotlinInt? = nil
) -> SharedSDK.AiUsageState {
    SharedSDK.AiUsageState(
        phase: phase,
        failure: failure,
        periods: periods,
        period: period,
        accountStartedAt: "2026-06-03T08:00:00Z",
        totalUsd: 24.12,
        estimated: true,
        points: [SharedSDK.UsagePointItem(key: "2026-10-20", costUsd: 1.5)],
        models: [
            SharedSDK.UsageModelItem(
                name: "Claude Sonnet",
                costUsd: 14,
                callCount: 820,
                inputTokens: KotlinLong(longLong: 3_000_000),
                outputTokens: KotlinLong(longLong: 900_000),
                audioSeconds: nil
            ),
            SharedSDK.UsageModelItem(
                name: "Whisper",
                costUsd: 4.3,
                callCount: 3,
                inputTokens: nil,
                outputTokens: nil,
                audioSeconds: KotlinDouble(double: 8040.5)
            )
        ],
        operations: [SharedSDK.UsageOperationItem(label: "Semp chat", costUsd: 15, share: 0.62, callCount: 900)],
        caps: caps,
        picked: picked
    )
}

private func trashState(
    phase: SharedSDK.TrashPhase,
    failure: SharedSDK.FailureKind? = nil,
    tab: SharedSDK.TrashTab = .items,
    items: [SharedSDK.TrashItemRow] = [],
    databases: [SharedSDK.TrashDatabaseRow] = [],
    hasMore: Bool = false,
    loadingMore: Bool = false,
    selecting: Bool = false,
    selected: [String] = [],
    working: Bool = false,
    writeFailure: SharedSDK.Failed? = nil
) -> SharedSDK.TrashState {
    SharedSDK.TrashState(
        phase: phase,
        failure: failure,
        tab: tab,
        items: items,
        databases: databases,
        totalItems: 3,
        hasMore: hasMore,
        loadingMore: loadingMore,
        selecting: selecting,
        selected: selected,
        working: working,
        writeFailure: writeFailure
    )
}
