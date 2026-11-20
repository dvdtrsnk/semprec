import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the internet accounts and internet account bridges' mappings between Kotlin and Swift
/// values with Kotlin values built here.
final class InternetAccountMappingTests: XCTestCase {

    // MARK: - Accounts
    @MainActor
    func testAccountsMapPhasesRowsAndConnectFailures() {
        XCTAssertEqual(SharedInternetAccountsScreenModel.state(accountsState(.loading)).phase, .loading)
        XCTAssertEqual(SharedInternetAccountsScreenModel.state(accountsState(.error)).phase, .failure(nil))
        let state = SharedInternetAccountsScreenModel.state(accountsState(.content, connectFailure: .refused))
        let item = CoreKit.InternetAccountItem(
            id: "m1", name: "Gmail", address: nil, provider: "gmail", mail: .ok, calendars: .needsConsent
        )
        XCTAssertEqual(state.accounts, [item])
        XCTAssertTrue(state.connecting)
        XCTAssertEqual(state.connectFailure, .refused)
        let failures: [(SharedSDK.InternetConnectFailure, CoreKit.InternetConnectFailure)] = [
            (.invalidInput, .invalidInput), (.refused, .refused),
            (.unavailable, .unavailable), (.unexpected, .unexpected), (.declined, .declined)
        ]
        for (kotlin, swift) in failures {
            let state = SharedInternetAccountsScreenModel.state(accountsState(.content, connectFailure: kotlin))
            XCTAssertEqual(state.connectFailure, swift)
        }
        XCTAssertNil(SharedInternetAccountsScreenModel.state(accountsState(.content)).connectFailure)
    }

    func testEveryServiceStatusAndServiceMaps() {
        let statuses: [(SharedSDK.InternetServiceStatus, CoreKit.InternetServiceStatus)] = [
            (.off, .off), (.pending, .pending), (.syncing, .syncing), (.ok, .ok), (.error, .error),
            (.needsReauthorization, .needsReauthorization), (.needsConsent, .needsConsent)
        ]
        for (kotlin, swift) in statuses {
            XCTAssertEqual(CoreKit.InternetServiceStatus(kotlin), swift)
        }
        let services: [(SharedSDK.InternetAccountService, CoreKit.InternetAccountService)] = [
            (.mail, .mail), (.calendars, .calendars)
        ]
        for (kotlin, swift) in services {
            XCTAssertEqual(CoreKit.InternetAccountService(kotlin), swift)
            XCTAssertEqual(swift.shared, kotlin)
        }
    }

    @MainActor
    func testAccountsMapEachActionAndEffect() throws {
        XCTAssertTrue(SharedInternetAccountsScreenModel.action(.retry) is SharedSDK.InternetAccountsActionRetry)
        XCTAssertTrue(SharedInternetAccountsScreenModel.action(.refresh) is SharedSDK.InternetAccountsActionRefresh)
        let dismiss = SharedInternetAccountsScreenModel.action(.dismissConnectFailure)
        XCTAssertTrue(dismiss is SharedSDK.InternetAccountsActionDismissConnectFailure)
        let open = try XCTUnwrap(
            SharedInternetAccountsScreenModel.action(.open(accountId: "m1")) as? SharedSDK.InternetAccountsActionOpen
        )
        XCTAssertEqual(open.accountId, "m1")
        let providers: [(CoreKit.InternetPasswordProvider, SharedSDK.InternetPasswordProvider)] = [
            (.icloud, .icloud), (.other, .other)
        ]
        for (provider, kotlin) in providers {
            let action = try XCTUnwrap(
                SharedInternetAccountsScreenModel.action(
                    .connect(
                        provider: provider, address: "a@x.cz", password: "pw", imapHost: "i", smtpHost: "s",
                        caldavUrl: "c"
                    )
                ) as? SharedSDK.InternetAccountsActionConnect
            )
            XCTAssertEqual(action.provider, kotlin)
            XCTAssertEqual(
                [action.address, action.password, action.imapHost, action.smtpHost, action.caldavUrl],
                ["a@x.cz", "pw", "i", "s", "c"]
            )
        }
        XCTAssertEqual(
            SharedInternetAccountsScreenModel.effect(SharedSDK.InternetAccountsEffectOpenAccount(accountId: "m1")),
            .openAccount(accountId: "m1")
        )
        XCTAssertEqual(
            SharedInternetAccountsScreenModel.effect(SharedSDK.InternetAccountsEffectConnected.shared),
            .connected
        )
        XCTAssertEqual(
            SharedInternetAccountsScreenModel.effect(SharedSDK.InternetAccountsEffectOpenSignIn(url: "https://g/a")),
            .openSignIn(url: "https://g/a")
        )
    }

    @MainActor
    func testAccountsMapEachSignInAction() throws {
        let providers: [(CoreKit.InternetOAuthProvider, SharedSDK.InternetOAuthProvider)] = [
            (.google, .google), (.microsoft, .microsoft)
        ]
        for (provider, kotlin) in providers {
            for calendars in [true, false] {
                let start = try XCTUnwrap(
                    SharedInternetAccountsScreenModel.action(.startSignIn(provider: provider, calendars: calendars))
                        as? SharedSDK.InternetAccountsActionSignInStart
                )
                XCTAssertEqual(start.provider, kotlin)
                XCTAssertEqual(start.calendars, calendars)
            }
        }
        let returned = try XCTUnwrap(
            SharedInternetAccountsScreenModel.action(.signInReturned(callbackUrl: "semprec://oauth?state=s&code=c"))
                as? SharedSDK.InternetAccountsActionSignInReturned
        )
        XCTAssertEqual(returned.callbackUrl, "semprec://oauth?state=s&code=c")
        XCTAssertTrue(
            SharedInternetAccountsScreenModel.action(.signInCancelled)
                is SharedSDK.InternetAccountsActionSignInCancelled
        )
        XCTAssertTrue(
            SharedInternetAccountsScreenModel.action(.signInFailed) is SharedSDK.InternetAccountsActionSignInFailed
        )
    }

    // MARK: - Account
    @MainActor
    func testAccountMapsPhasesDetailServicesAndRemoval() {
        XCTAssertEqual(SharedInternetAccountScreenModel.state(accountState(.loading)).phase, .loading)
        let missing = SharedInternetAccountScreenModel.state(accountState(.error, failure: .notFound))
        XCTAssertEqual(missing.phase, .failure(.notFound))
        let state = SharedInternetAccountScreenModel.state(accountState(.content))
        XCTAssertEqual(
            state.account,
            CoreKit.InternetAccountDetail(
                id: "m1", name: "Gmail", address: "me@gmail.com", provider: "gmail", syncMode: "imap",
                mailEnabled: false, calendarsEnabled: true, mail: .off, calendars: .pending,
                lastSuccessfulSyncAt: "2026-10-19T08:12:00Z", failingSince: "2026-10-19T09:12:00Z",
                connectionLimit: 3, connectionLimitApplies: true, autonomousSendProjectCount: 1,
                syncedMessageCount: 42, signsInInBrowser: true, canSignInAgain: false, canAllowCalendarAccess: false
            )
        )
        XCTAssertEqual(state.confirmingOff, .calendars)
        XCTAssertNil(SharedInternetAccountScreenModel.state(accountState(.content, confirmingOff: nil)).confirmingOff)
        XCTAssertTrue(state.syncRequested)
        XCTAssertEqual(state.removal, .confirming)
        XCTAssertEqual(
            state.impact,
            CoreKit.InternetAccountRemovalImpact(messages: 120, drafts: 2, threads: 50, attachmentsKept: 7)
        )
        XCTAssertTrue(state.actionFailed)
        XCTAssertTrue(state.signingIn)
        XCTAssertEqual(state.signInFailure, .declined)
        XCTAssertNil(SharedInternetAccountScreenModel.state(accountState(.content, signInFailure: nil)).signInFailure)
        let offers = SharedInternetAccountScreenModel.state(
            accountState(.content, mail: .needsReauthorization, calendars: .needsConsent)
        ).account
        XCTAssertEqual(offers?.canSignInAgain, true)
        XCTAssertEqual(offers?.canAllowCalendarAccess, true)
        let phases: [(SharedSDK.InternetAccountRemovalPhase, CoreKit.InternetAccountRemovalPhase)] = [
            (.idle, .idle), (.loadingImpact, .loadingImpact), (.confirming, .confirming), (.removing, .removing)
        ]
        for (kotlin, swift) in phases {
            XCTAssertEqual(
                SharedInternetAccountScreenModel.state(accountState(.content, removal: kotlin)).removal,
                swift
            )
        }
    }

    @MainActor
    func testAccountMapsEachActionAndEffect() throws {
        let simple: [(CoreKit.InternetAccountAction, Any.Type)] = [
            (.retry, SharedSDK.InternetAccountActionRetry.self),
            (.confirmServiceOff, SharedSDK.InternetAccountActionConfirmServiceOff.self),
            (.cancelServiceOff, SharedSDK.InternetAccountActionCancelServiceOff.self),
            (.syncNow, SharedSDK.InternetAccountActionSyncNow.self),
            (.requestRemoval, SharedSDK.InternetAccountActionRemovalRequest.self),
            (.cancelRemoval, SharedSDK.InternetAccountActionRemovalCancel.self),
            (.confirmRemoval, SharedSDK.InternetAccountActionRemovalConfirm.self),
            (.dismissFailure, SharedSDK.InternetAccountActionDismissFailure.self),
            (.signIn(.again), SharedSDK.InternetAccountActionSignInAgain.self),
            (.signIn(.allowCalendarAccess), SharedSDK.InternetAccountActionSignInAllowCalendarAccess.self),
            (.signIn(.cancelled), SharedSDK.InternetAccountActionSignInCancelled.self),
            (.signIn(.failed), SharedSDK.InternetAccountActionSignInFailed.self)
        ]
        for (action, kotlin) in simple {
            XCTAssertTrue(type(of: SharedInternetAccountScreenModel.action(action)) == kotlin, "\(action)")
        }
        let toggle = try XCTUnwrap(
            SharedInternetAccountScreenModel.action(.setService(.calendars, enabled: true))
                as? SharedSDK.InternetAccountActionSetService
        )
        XCTAssertEqual(toggle.service, .calendars)
        XCTAssertTrue(toggle.enabled)
        let rename = try XCTUnwrap(
            SharedInternetAccountScreenModel.action(.rename("Osobní")) as? SharedSDK.InternetAccountActionRename
        )
        XCTAssertEqual(rename.name, "Osobní")
        let step = try XCTUnwrap(
            SharedInternetAccountScreenModel.action(.stepConnectionLimit(delta: -1))
                as? SharedSDK.InternetAccountActionStepConnectionLimit
        )
        XCTAssertEqual(step.delta, -1)
        let returned = try XCTUnwrap(
            SharedInternetAccountScreenModel.action(.signIn(.returned(callbackUrl: "semprec://oauth?state=s&error=e")))
                as? SharedSDK.InternetAccountActionSignInReturned
        )
        XCTAssertEqual(returned.callbackUrl, "semprec://oauth?state=s&error=e")
        XCTAssertEqual(
            SharedInternetAccountScreenModel.effect(SharedSDK.InternetAccountEffectRemoved.shared),
            .removed
        )
        XCTAssertEqual(
            SharedInternetAccountScreenModel.effect(SharedSDK.InternetAccountEffectCalendarsTurnedOn.shared),
            .calendarsTurnedOn
        )
        XCTAssertEqual(
            SharedInternetAccountScreenModel.effect(SharedSDK.InternetAccountEffectOpenSignIn(url: "https://g/a")),
            .openSignIn(url: "https://g/a")
        )
    }
}

// MARK: - Kotlin values
private extension InternetAccountMappingTests {

    func accountsState(
        _ phase: SharedSDK.InternetAccountsPhase,
        connectFailure: SharedSDK.InternetConnectFailure? = nil
    ) -> SharedSDK.InternetAccountsState {
        SharedSDK.InternetAccountsState(
            phase: phase,
            failure: nil,
            refreshing: false,
            accounts: [
                SharedSDK.InternetAccountItem(
                    id: "m1", name: "Gmail", address: nil, provider: "gmail", mail: .ok, calendars: .needsConsent
                )
            ],
            connecting: true,
            connectFailure: connectFailure
        )
    }

    func accountState(
        _ phase: SharedSDK.InternetAccountPhase,
        failure: SharedSDK.FailureKind? = nil,
        confirmingOff: SharedSDK.InternetAccountService? = .calendars,
        removal: SharedSDK.InternetAccountRemovalPhase = .confirming,
        signInFailure: SharedSDK.InternetConnectFailure? = .declined,
        mail: SharedSDK.InternetServiceStatus = .off,
        calendars: SharedSDK.InternetServiceStatus = .pending
    ) -> SharedSDK.InternetAccountState {
        SharedSDK.InternetAccountState(
            phase: phase,
            failure: failure,
            account: SharedSDK.InternetAccountDetail(
                id: "m1",
                name: "Gmail",
                address: "me@gmail.com",
                provider: "gmail",
                syncMode: "imap",
                mailEnabled: false,
                calendarsEnabled: true,
                mail: mail,
                calendars: calendars,
                lastSuccessfulSyncAt: "2026-10-19T08:12:00Z",
                failingSince: "2026-10-19T09:12:00Z",
                connectionLimit: 3,
                connectionLimitApplies: true,
                autonomousSendProjectCount: 1,
                syncedMessageCount: 42,
                signsInInBrowser: true
            ),
            confirmingOff: confirmingOff,
            syncRequested: true,
            removal: removal,
            impact: SharedSDK.InternetAccountRemovalImpact(messages: 120, drafts: 2, threads: 50, attachmentsKept: 7),
            actionFailed: true,
            signingIn: true,
            signInFailure: signInFailure
        )
    }
}
