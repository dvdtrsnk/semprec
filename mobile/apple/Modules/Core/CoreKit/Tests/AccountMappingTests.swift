import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the account bridges' mappings between Kotlin and Swift values with Kotlin values built here.
/// Both modules declare most of these type names, so each is qualified with its module.
final class AccountMappingTests: XCTestCase {

    // MARK: - Profile
    @MainActor
    func testProfileMapsEveryPhaseAndTheIdentityWithoutFigures() {
        let phases: [(SharedSDK.ProfilePhase, CoreKit.ProfilePhase)] = [(.loading, .loading), (.content, .content), (.error, .error)]
        for (shared, expected) in phases {
            XCTAssertEqual(SharedProfileScreenModel.state(profileState(phase: shared)).phase, expected)
        }
        let state = SharedProfileScreenModel.state(profileState(phase: .error, failure: .unavailable))
        XCTAssertEqual(state.failure, .unavailable)
        XCTAssertEqual(state.email, "a@b.cz")
        XCTAssertEqual(state.serverUrl, "https://s.example")
        XCTAssertEqual(state.locale, "cs")
        XCTAssertEqual(state.locales, ["cs", "en"])
        XCTAssertNil(state.figures)
        XCTAssertNil(SharedProfileScreenModel.state(profileState(phase: .error)).failure)
    }

    @MainActor
    func testProfileMapsTheFiguresTheResetPhaseAndTheWriteFailure() {
        let figures = SharedSDK.ProfileFigures(
            activeSessions: 4, mailAccountCount: 2, mailAccountsNeedingReauth: 1, trashCount: 9, problemCount: 3, aiCostMonthUsd: 24.12
        )
        let phases: [(SharedSDK.ProfileResetPhase, CoreKit.ProfileResetPhase)] = [
            (.idle, .idle), (.sending, .sending), (.sent, .sent), (.failed, .failed)
        ]
        for (shared, expected) in phases {
            XCTAssertEqual(SharedProfileScreenModel.state(profileState(figures: figures, resetPhase: shared)).resetPhase, expected)
        }
        let state = SharedProfileScreenModel.state(
            profileState(
                figures: figures,
                localeSaving: true,
                writeFailure: SharedSDK.Failed(kind: .rejected)
            )
        )
        XCTAssertEqual(
            state.figures,
            ProfileFigures(
                activeSessions: 4,
                mailAccountCount: 2,
                mailAccountsNeedingReauth: 1,
                trashCount: 9,
                problemCount: 3,
                aiCostMonthUsd: 24.12
            )
        )
        XCTAssertTrue(state.localeSaving)
        XCTAssertEqual(state.writeFailure, Failed(kind: .rejected))
    }

    @MainActor
    func testProfileMapsEachActionAndEachPageBothWays() throws {
        XCTAssertTrue(SharedProfileScreenModel.action(.retry) is SharedSDK.ProfileActionRetry)
        XCTAssertTrue(SharedProfileScreenModel.action(.requestPasswordReset) is SharedSDK.ProfileActionRequestPasswordReset)
        XCTAssertTrue(SharedProfileScreenModel.action(.signOut) is SharedSDK.ProfileActionSignOut)
        XCTAssertTrue(SharedProfileScreenModel.action(.dismissFailure) is SharedSDK.ProfileActionDismissFailure)
        let locale = try XCTUnwrap(SharedProfileScreenModel.action(.changeLocale("en")) as? SharedSDK.ProfileActionChangeLocale)
        XCTAssertEqual(locale.locale, "en")
        let open = try XCTUnwrap(SharedProfileScreenModel.action(.open(.trash)) as? SharedSDK.ProfileActionOpen)
        XCTAssertEqual(open.page, .trash)
        for page in CoreKit.AccountPage.allCases {
            XCTAssertEqual(SharedProfileScreenModel.page(SharedProfileScreenModel.sharedPage(page)), page)
            XCTAssertEqual(SharedProfileScreenModel.effect(SharedSDK.ProfileEffectOpen(page: SharedProfileScreenModel.sharedPage(page))), page)
        }
    }

    // MARK: - Devices
    @MainActor
    func testDevicesMapsEveryPhaseAndTheirDevices() {
        let phases: [(SharedSDK.DevicesPhase, CoreKit.DevicesPhase)] = [(.loading, .loading), (.content, .content), (.error, .error)]
        for (shared, expected) in phases {
            XCTAssertEqual(SharedDevicesScreenModel.state(devicesState(phase: shared)).phase, expected)
        }
        let state = SharedDevicesScreenModel.state(
            devicesState(
                phase: .content,
                failure: .unauthorized,
                current: device("s1", .iphone, .ios, "iPhone"),
                others: [device("s2", .mac, .macos, nil), device("s3", .browser, .web, "Safari")],
                working: true,
                writeFailure: SharedSDK.Failed(kind: nil)
            )
        )
        XCTAssertEqual(state.failure, .unauthorized)
        XCTAssertEqual(state.current, DeviceItem(id: "s1", kind: .iphone, platform: .ios, name: "iPhone", createdAt: "c", lastSeenAt: "l"))
        XCTAssertEqual(state.others.map(\.id), ["s2", "s3"])
        XCTAssertEqual(state.others.map(\.name), [nil, "Safari"])
        XCTAssertTrue(state.working)
        XCTAssertEqual(state.writeFailure, Failed(kind: nil))
    }

    @MainActor
    func testDevicesMapsEveryKindPlatformAndConfirmation() {
        let kinds: [(SharedSDK.AccountDeviceKind, CoreKit.AccountDeviceKind)] = [
            (.iphone, .iphone), (.ipad, .ipad), (.mac, .mac), (.browser, .browser), (.unknown, .unknown)
        ]
        for (shared, expected) in kinds {
            XCTAssertEqual(SharedDevicesScreenModel.kind(shared), expected)
        }
        let platforms: [(SharedSDK.AccountPlatform, CoreKit.AccountPlatform)] = [
            (.web, .web), (.ios, .ios), (.macos, .macos), (.unknown, .unknown)
        ]
        for (shared, expected) in platforms {
            XCTAssertEqual(SharedDevicesScreenModel.platform(shared), expected)
        }
        let one = SharedDevicesScreenModel.state(
            devicesState(phase: .content, confirm: SharedSDK.DevicesConfirmOne(device: device("s2", .mac, .macos, "Mac")))
        )
        XCTAssertEqual(one.confirm, .one(DeviceItem(id: "s2", kind: .mac, platform: .macos, name: "Mac", createdAt: "c", lastSeenAt: "l")))
        let others = SharedDevicesScreenModel.state(devicesState(phase: .content, confirm: SharedSDK.DevicesConfirmOthers.shared))
        XCTAssertEqual(others.confirm, .others)
        XCTAssertNil(SharedDevicesScreenModel.state(devicesState(phase: .content)).confirm)
    }

    @MainActor
    func testDevicesMapsEachAction() throws {
        XCTAssertTrue(SharedDevicesScreenModel.action(.retry) is SharedSDK.DevicesActionRetry)
        XCTAssertTrue(SharedDevicesScreenModel.action(.askOthers) is SharedSDK.DevicesActionAskOthers)
        XCTAssertTrue(SharedDevicesScreenModel.action(.cancel) is SharedSDK.DevicesActionCancel)
        XCTAssertTrue(SharedDevicesScreenModel.action(.confirm) is SharedSDK.DevicesActionConfirm)
        XCTAssertTrue(SharedDevicesScreenModel.action(.dismissFailure) is SharedSDK.DevicesActionDismissFailure)
        let ask = try XCTUnwrap(SharedDevicesScreenModel.action(.ask(deviceId: "s2")) as? SharedSDK.DevicesActionAsk)
        XCTAssertEqual(ask.deviceId, "s2")
    }

    // MARK: - Notification settings
    @MainActor
    func testNotificationSettingsMapsEveryPhaseAndTheChoices() {
        let phases: [(SharedSDK.NotificationSettingsPhase, CoreKit.NotificationSettingsPhase)] = [
            (.loading, .loading), (.content, .content), (.error, .error)
        ]
        for (shared, expected) in phases {
            XCTAssertEqual(SharedNotificationSettingsScreenModel.state(notificationState(phase: shared)).phase, expected)
        }
        let state = SharedNotificationSettingsScreenModel.state(
            notificationState(
                phase: .content,
                failure: .unavailable,
                choices: notificationChoices(.all),
                writeFailure: SharedSDK.Failed(kind: .rejected)
            )
        )
        XCTAssertEqual(state.failure, .unavailable)
        XCTAssertEqual(
            state.choices,
            NotificationChoices(
                approvals: true,
                invites: false,
                reminders: true,
                problemsLevel: .all,
                problemsSummary: false,
                badgeApprovals: true,
                badgeInvites: false,
                badgeInbox: true
            )
        )
        XCTAssertEqual(state.writeFailure, Failed(kind: .rejected))
        XCTAssertNil(SharedNotificationSettingsScreenModel.state(notificationState(phase: .error)).choices)
    }

    @MainActor
    func testNotificationSettingsMapsEveryLevelSwitchAndAction() throws {
        for level in CoreKit.AccountProblemsLevel.allCases {
            let shared = SharedNotificationSettingsScreenModel.sharedLevel(level)
            XCTAssertEqual(SharedNotificationSettingsScreenModel.level(shared), level)
        }
        let switches: [(CoreKit.AccountNotificationSwitch, SharedSDK.AccountNotificationSwitch)] = [
            (.approvals, .approvals), (.invites, .invites), (.reminders, .reminders), (.problemsSummary, .problemsSummary),
            (.badgeApprovals, .badgeApprovals), (.badgeInvites, .badgeInvites), (.badgeInbox, .badgeInbox)
        ]
        XCTAssertEqual(switches.count, CoreKit.AccountNotificationSwitch.allCases.count)
        for (swift, shared) in switches {
            let action = try XCTUnwrap(
                SharedNotificationSettingsScreenModel.action(.set(swift, on: false)) as? SharedSDK.NotificationSettingsActionSet
            )
            XCTAssertEqual(action.choice, shared)
            XCTAssertFalse(action.on)
        }
        XCTAssertTrue(SharedNotificationSettingsScreenModel.action(.retry) is SharedSDK.NotificationSettingsActionRetry)
        XCTAssertTrue(
            SharedNotificationSettingsScreenModel.action(.dismissFailure) is SharedSDK.NotificationSettingsActionDismissFailure
        )
        let level = try XCTUnwrap(
            SharedNotificationSettingsScreenModel.action(.setProblemsLevel(.off)) as? SharedSDK.NotificationSettingsActionSetProblemsLevel
        )
        XCTAssertEqual(level.level, .off)
    }

    // MARK: - AI usage
    @MainActor
    func testAiUsageMapsEveryPhaseAndTheContent() {
        let phases: [(SharedSDK.AiUsagePhase, CoreKit.AiUsagePhase)] = [(.loading, .loading), (.content, .content), (.error, .error)]
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
        XCTAssertEqual(
            state.models,
            [
                UsageModelItem(
                    name: "Claude Sonnet", costUsd: 14, callCount: 820, inputTokens: 3_000_000, outputTokens: 900_000, audioSeconds: nil
                ),
                UsageModelItem(
                    name: "Whisper", costUsd: 4.3, callCount: 3, inputTokens: nil, outputTokens: nil, audioSeconds: 8040.5
                )
            ]
        )
        XCTAssertEqual(state.operations, [UsageOperationItem(label: "Semp chat", costUsd: 15, share: 0.62, callCount: 900)])
        XCTAssertEqual(state.caps, UsageCaps(dailyUsd: 50, monthlyUsd: nil, exhausted: true))
        XCTAssertEqual(state.picked, 1)
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
        let select = try XCTUnwrap(SharedAiUsageScreenModel.action(.selectPeriod(.all)) as? SharedSDK.AiUsageActionSelectPeriod)
        XCTAssertTrue(select.period is SharedSDK.UsagePeriodAll)
        for period in [UsagePeriod.week, .all, .month("2026-09")] {
            XCTAssertEqual(SharedAiUsageScreenModel.period(SharedAiUsageScreenModel.sharedPeriod(period)), period)
        }
    }

    // MARK: - Trash
    @MainActor
    func testTrashMapsEveryPhaseAndTab() {
        let phases: [(SharedSDK.TrashPhase, CoreKit.TrashPhase)] = [(.loading, .loading), (.content, .content), (.error, .error)]
        for (shared, expected) in phases {
            XCTAssertEqual(SharedTrashScreenModel.state(trashState(phase: shared)).phase, expected)
        }
        for tab in [CoreKit.TrashTab.items, .databases] {
            XCTAssertEqual(SharedTrashScreenModel.tab(SharedTrashScreenModel.sharedTab(tab)), tab)
        }
        XCTAssertEqual(SharedTrashScreenModel.state(trashState(phase: .error, failure: .unavailable)).failure, .unavailable)
    }

    @MainActor
    func testTrashMapsTheRowsTheSelectionAndTheWriteFailure() {
        let state = SharedTrashScreenModel.state(
            trashState(
                phase: .content,
                tab: .databases,
                items: [SharedSDK.TrashItemRow(id: "i1", title: "Zarovka", databaseKey: "tasks", databaseName: "Ukoly", deletedAt: "d", daysLeft: 30)],
                databases: [
                    SharedSDK.TrashDatabaseRow(id: "d1", name: "Recepty", itemCount: 42, archivedAt: "a", daysLeft: KotlinInt(int: 27)),
                    SharedSDK.TrashDatabaseRow(id: "d2", name: "Napady", itemCount: 0, archivedAt: "b", daysLeft: nil)
                ],
                hasMore: true,
                loadingMore: true,
                selecting: true,
                selected: ["d1"],
                working: true,
                writeFailure: SharedSDK.Failed(kind: .rejected)
            )
        )
        XCTAssertEqual(state.tab, .databases)
        XCTAssertEqual(
            state.items,
            [TrashItemRow(id: "i1", title: "Zarovka", databaseKey: "tasks", databaseName: "Ukoly", deletedAt: "d", daysLeft: 30)]
        )
        XCTAssertEqual(
            state.databases,
            [
                TrashDatabaseRow(id: "d1", name: "Recepty", itemCount: 42, archivedAt: "a", daysLeft: 27),
                TrashDatabaseRow(id: "d2", name: "Napady", itemCount: 0, archivedAt: "b", daysLeft: nil)
            ]
        )
        XCTAssertEqual(state.totalItems, 3)
        XCTAssertTrue(state.hasMore)
        XCTAssertTrue(state.loadingMore)
        XCTAssertTrue(state.selecting)
        XCTAssertEqual(state.selected, ["d1"])
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
        let tab = try XCTUnwrap(SharedTrashScreenModel.action(.selectTab(.databases)) as? SharedSDK.TrashActionSelectTab)
        XCTAssertEqual(tab.tab, .databases)
        let toggle = try XCTUnwrap(SharedTrashScreenModel.action(.toggle(id: "i1")) as? SharedSDK.TrashActionToggle)
        XCTAssertEqual(toggle.id, "i1")
        let restore = try XCTUnwrap(SharedTrashScreenModel.action(.restore(id: "i2")) as? SharedSDK.TrashActionRestore)
        XCTAssertEqual(restore.id, "i2")
        XCTAssertEqual(
            SharedTrashScreenModel.effect(SharedSDK.TrashEffectRestored(restored: 2, refused: 1, databaseName: "Ukoly")),
            .restored(restored: 2, refused: 1, databaseName: "Ukoly")
        )
        XCTAssertEqual(
            SharedTrashScreenModel.effect(SharedSDK.TrashEffectRestored(restored: 1, refused: 0, databaseName: nil)),
            .restored(restored: 1, refused: 0, databaseName: nil)
        )
    }
}

// MARK: - Kotlin values
private func profileState(
    phase: SharedSDK.ProfilePhase = .content,
    failure: SharedSDK.FailureKind? = nil,
    figures: SharedSDK.ProfileFigures? = nil,
    localeSaving: Bool = false,
    resetPhase: SharedSDK.ProfileResetPhase = .idle,
    writeFailure: SharedSDK.Failed? = nil
) -> SharedSDK.ProfileState {
    SharedSDK.ProfileState(
        phase: phase,
        failure: failure,
        email: "a@b.cz",
        serverUrl: "https://s.example",
        locale: "cs",
        locales: ["cs", "en"],
        figures: figures,
        localeSaving: localeSaving,
        resetPhase: resetPhase,
        writeFailure: writeFailure
    )
}

private func device(
    _ id: String,
    _ kind: SharedSDK.AccountDeviceKind,
    _ platform: SharedSDK.AccountPlatform,
    _ name: String?
) -> SharedSDK.DeviceItem {
    SharedSDK.DeviceItem(id: id, kind: kind, platform: platform, name: name, createdAt: "c", lastSeenAt: "l")
}

private func devicesState(
    phase: SharedSDK.DevicesPhase,
    failure: SharedSDK.FailureKind? = nil,
    current: SharedSDK.DeviceItem? = nil,
    others: [SharedSDK.DeviceItem] = [],
    confirm: (any SharedSDK.DevicesConfirm)? = nil,
    working: Bool = false,
    writeFailure: SharedSDK.Failed? = nil
) -> SharedSDK.DevicesState {
    SharedSDK.DevicesState(
        phase: phase,
        failure: failure,
        current: current,
        others: others,
        confirm: confirm,
        working: working,
        writeFailure: writeFailure
    )
}

private func notificationChoices(_ level: SharedSDK.AccountProblemsLevel) -> SharedSDK.NotificationChoices {
    SharedSDK.NotificationChoices(
        approvals: true,
        invites: false,
        reminders: true,
        problemsLevel: level,
        problemsSummary: false,
        badgeApprovals: true,
        badgeInvites: false,
        badgeInbox: true
    )
}

private func notificationState(
    phase: SharedSDK.NotificationSettingsPhase,
    failure: SharedSDK.FailureKind? = nil,
    choices: SharedSDK.NotificationChoices? = nil,
    writeFailure: SharedSDK.Failed? = nil
) -> SharedSDK.NotificationSettingsState {
    SharedSDK.NotificationSettingsState(phase: phase, failure: failure, choices: choices, writeFailure: writeFailure)
}

private func aiUsageState(
    phase: SharedSDK.AiUsagePhase,
    failure: SharedSDK.FailureKind? = nil,
    periods: [any SharedSDK.UsagePeriod] = [],
    period: any SharedSDK.UsagePeriod = SharedSDK.UsagePeriodWeek.shared,
    caps: SharedSDK.UsageCaps? = SharedSDK.UsageCaps(dailyUsd: KotlinDouble(double: 50), monthlyUsd: nil, exhausted: true),
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
