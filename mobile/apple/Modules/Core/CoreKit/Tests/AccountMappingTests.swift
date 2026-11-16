import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the account bridges' mappings between Kotlin and Swift values with Kotlin values built here.
/// Both modules declare most of these type names, so each is qualified with its module.
final class AccountMappingTests: XCTestCase {

    // MARK: - Profile
    @MainActor
    func testProfileMapsEveryPhaseAndTheIdentityWithoutFigures() {
        let phases: [
            (SharedSDK.ProfilePhase, CoreKit.ProfilePhase)
        ] = [(.loading, .loading), (.content, .content), (.error, .error)]
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
            activeSessions: 4,
            mailAccountCount: 2,
            mailAccountsNeedingReauth: 1,
            trashCount: 9,
            problemCount: 3,
            aiCostMonthUsd: 24.12
        )
        let phases: [(SharedSDK.ProfileResetPhase, CoreKit.ProfileResetPhase)] = [
            (.idle, .idle), (.sending, .sending), (.sent, .sent), (.failed, .failed)
        ]
        for (shared, expected) in phases {
            XCTAssertEqual(
                SharedProfileScreenModel.state(profileState(figures: figures, resetPhase: shared)).resetPhase,
                expected
            )
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
        XCTAssertTrue(
            SharedProfileScreenModel.action(.requestPasswordReset) is SharedSDK.ProfileActionRequestPasswordReset
        )
        XCTAssertTrue(SharedProfileScreenModel.action(.signOut) is SharedSDK.ProfileActionSignOut)
        XCTAssertTrue(SharedProfileScreenModel.action(.dismissFailure) is SharedSDK.ProfileActionDismissFailure)
        let locale = try XCTUnwrap(
            SharedProfileScreenModel.action(.changeLocale("en")) as? SharedSDK.ProfileActionChangeLocale
        )
        XCTAssertEqual(locale.locale, "en")
        let open = try XCTUnwrap(SharedProfileScreenModel.action(.open(.trash)) as? SharedSDK.ProfileActionOpen)
        XCTAssertEqual(open.page, .trash)
        for page in CoreKit.AccountPage.allCases {
            XCTAssertEqual(SharedProfileScreenModel.page(SharedProfileScreenModel.sharedPage(page)), page)
            XCTAssertEqual(
                SharedProfileScreenModel.effect(
                    SharedSDK.ProfileEffectOpen(page: SharedProfileScreenModel.sharedPage(page))
                ),
                page
            )
        }
    }

    // MARK: - Devices
    @MainActor
    func testDevicesMapsEveryPhaseAndTheirDevices() {
        let phases: [
            (SharedSDK.DevicesPhase, CoreKit.DevicesPhase)
        ] = [(.loading, .loading), (.content, .content), (.error, .error)]
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
        XCTAssertEqual(
            state.current,
            DeviceItem(id: "s1", kind: .iphone, platform: .ios, name: "iPhone", createdAt: "c", lastSeenAt: "l")
        )
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
            devicesState(
                phase: .content,
                confirm: SharedSDK.DevicesConfirmOne(device: device("s2", .mac, .macos, "Mac"))
            )
        )
        XCTAssertEqual(
            one.confirm,
            .one(DeviceItem(id: "s2", kind: .mac, platform: .macos, name: "Mac", createdAt: "c", lastSeenAt: "l"))
        )
        let others = SharedDevicesScreenModel.state(
            devicesState(phase: .content, confirm: SharedSDK.DevicesConfirmOthers.shared)
        )
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
            XCTAssertEqual(
                SharedNotificationSettingsScreenModel.state(notificationState(phase: shared)).phase,
                expected
            )
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
            (
                .approvals,
                .approvals
            ), (.invites, .invites), (.reminders, .reminders), (.problemsSummary, .problemsSummary),
            (.badgeApprovals, .badgeApprovals), (.badgeInvites, .badgeInvites), (.badgeInbox, .badgeInbox)
        ]
        XCTAssertEqual(switches.count, CoreKit.AccountNotificationSwitch.allCases.count)
        for (swift, shared) in switches {
            let action = try XCTUnwrap(
                SharedNotificationSettingsScreenModel.action(
                    .set(swift, enabled: false)
                ) as? SharedSDK.NotificationSettingsActionSet
            )
            XCTAssertEqual(action.choice, shared)
            XCTAssertFalse(action.on)
        }
        XCTAssertTrue(SharedNotificationSettingsScreenModel.action(.retry) is SharedSDK.NotificationSettingsActionRetry)
        XCTAssertTrue(
            SharedNotificationSettingsScreenModel.action(
                .dismissFailure
            ) is SharedSDK.NotificationSettingsActionDismissFailure
        )
        let level = try XCTUnwrap(
            SharedNotificationSettingsScreenModel.action(
                .setProblemsLevel(.off)
            ) as? SharedSDK.NotificationSettingsActionSetProblemsLevel
        )
        XCTAssertEqual(level.level, .off)
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
