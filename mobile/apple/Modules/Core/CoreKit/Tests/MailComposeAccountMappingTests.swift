import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the compose, mailboxes, accounts and account bridges' mappings between Kotlin and Swift
/// values with Kotlin values built here.
final class MailComposeAccountMappingTests: XCTestCase {

    // MARK: - Compose
    @MainActor
    func testComposeMapsEveryPhase() {
        XCTAssertEqual(SharedMailComposeScreenModel.state(composeState(.loading)).phase, .loading)
        XCTAssertEqual(SharedMailComposeScreenModel.state(composeState(.editing)).phase, .editing)
        XCTAssertEqual(
            SharedMailComposeScreenModel.state(composeState(.error, failure: .unavailable)).phase,
            .failure(.unavailable)
        )
        XCTAssertEqual(SharedMailComposeScreenModel.state(composeState(.error)).phase, .failure(nil))
    }

    @MainActor
    func testComposeMapsTheFieldsRecipientsAndSendState() {
        let state = SharedMailComposeScreenModel.state(composeState(.editing))
        XCTAssertEqual(state.senders, [CoreKit.MailSender(mailboxId: "m1", name: "Gmail", address: "me@gmail.com")])
        XCTAssertEqual(state.senderId, "m1")
        XCTAssertEqual(state.toRecipients, [CoreKit.MailRecipient(name: "Petr", address: "p@x.cz")])
        XCTAssertEqual(state.ccRecipients, [CoreKit.MailRecipient(name: "", address: "c@x.cz")])
        XCTAssertEqual(state.initialSubject, "Re")
        XCTAssertEqual(state.initialBody, "Text")
        let jana = CoreKit.MailSuggestion(name: "Jana", address: "j@x.cz", relationship: "Přítel")
        XCTAssertEqual(state.suggestions, [jana])
        XCTAssertTrue(state.invalidAddress && state.discardFailed)
        XCTAssertEqual(state.sendPhase, .sent)
        XCTAssertEqual(state.sendFailure, .rejected)
        XCTAssertEqual(state.sentFrom, "Gmail")
    }

    @MainActor
    func testComposeMapsEachActionAndEffect() throws {
        XCTAssertTrue(SharedMailComposeScreenModel.action(.retry) is SharedSDK.MailComposeActionRetry)
        XCTAssertTrue(SharedMailComposeScreenModel.action(.cancel) is SharedSDK.MailComposeActionCancel)
        let search = try XCTUnwrap(
            SharedMailComposeScreenModel.action(.searchContacts("pet")) as? SharedSDK.MailComposeActionSearchContacts
        )
        XCTAssertEqual(search.text, "pet")
        let add = try XCTUnwrap(
            SharedMailComposeScreenModel.action(.addRecipient(name: "Petr", address: "p@x.cz"))
                as? SharedSDK.MailComposeActionAddRecipient
        )
        XCTAssertEqual([add.name, add.address], ["Petr", "p@x.cz"])
        let typed = try XCTUnwrap(
            SharedMailComposeScreenModel.action(.addAddress("a@x.cz")) as? SharedSDK.MailComposeActionAddAddress
        )
        XCTAssertEqual(typed.text, "a@x.cz")
        let remove = try XCTUnwrap(
            SharedMailComposeScreenModel.action(.removeRecipient(address: "p@x.cz"))
                as? SharedSDK.MailComposeActionRemoveRecipient
        )
        XCTAssertEqual(remove.address, "p@x.cz")
        let sender = try XCTUnwrap(
            SharedMailComposeScreenModel.action(.selectSender(mailboxId: "m2"))
                as? SharedSDK.MailComposeActionSelectSender
        )
        XCTAssertEqual(sender.mailboxId, "m2")
        let send = try XCTUnwrap(
            SharedMailComposeScreenModel.action(.send(subject: "S", body: "B")) as? SharedSDK.MailComposeActionSend
        )
        XCTAssertEqual([send.subject, send.body], ["S", "B"])
        XCTAssertEqual(SharedMailComposeScreenModel.effect(SharedSDK.MailComposeEffectClose.shared), .close)
    }

    // MARK: - Folders
    @MainActor
    func testFoldersMapPhasesCountsAndAccounts() {
        XCTAssertEqual(SharedMailFoldersScreenModel.state(foldersState(.loading)).phase, .loading)
        XCTAssertEqual(
            SharedMailFoldersScreenModel.state(foldersState(.error, failure: .unauthorized)).phase,
            .failure(.unauthorized)
        )
        let state = SharedMailFoldersScreenModel.state(foldersState(.content))
        XCTAssertEqual(state.phase, .content)
        XCTAssertEqual([state.unreadInbox, state.flagged, state.sempDrafts], [5, 2, 1])
        XCTAssertEqual(
            state.accounts,
            [
                CoreKit.MailFolderAccount(
                    id: "m1", name: "Gmail", address: "me@gmail.com", status: .syncing,
                    folders: [CoreKit.MailFolderItem(id: "f1", name: "Inbox", specialPurpose: "inbox", unreadCount: 3)],
                    foldersFailed: true, collapsed: true
                )
            ]
        )
    }

    @MainActor
    func testFoldersMapEveryAccountStatus() {
        let statuses: [(SharedSDK.MailAccountStatus, CoreKit.MailAccountStatus)] = [
            (.ok, .ok), (.syncing, .syncing), (.error, .error), (.needsReauthorization, .needsReauthorization)
        ]
        for (kotlin, swift) in statuses {
            XCTAssertEqual(CoreKit.MailAccountStatus(kotlin), swift)
        }
    }

    @MainActor
    func testFoldersMapEachActionAndEffect() throws {
        XCTAssertTrue(SharedMailFoldersScreenModel.action(.retry) is SharedSDK.MailFoldersActionRetry)
        XCTAssertTrue(SharedMailFoldersScreenModel.action(.refresh) is SharedSDK.MailFoldersActionRefresh)
        XCTAssertTrue(SharedMailFoldersScreenModel.action(.compose) is SharedSDK.MailFoldersActionCompose)
        XCTAssertTrue(SharedMailFoldersScreenModel.action(.openAccounts) is SharedSDK.MailFoldersActionOpenAccounts)
        let toggle = try XCTUnwrap(
            SharedMailFoldersScreenModel.action(.toggleAccount(mailboxId: "m1"))
                as? SharedSDK.MailFoldersActionToggleAccount
        )
        XCTAssertEqual(toggle.mailboxId, "m1")
        let box = try XCTUnwrap(
            SharedMailFoldersScreenModel.action(.openBox(.flagged)) as? SharedSDK.MailFoldersActionOpenBox
        )
        XCTAssertEqual(box.box, .flagged)
        let folder = try XCTUnwrap(
            SharedMailFoldersScreenModel.action(.openFolder(mailboxId: "m1", folderId: "f1"))
                as? SharedSDK.MailFoldersActionOpenFolder
        )
        XCTAssertEqual([folder.mailboxId, folder.folderId], ["m1", "f1"])
        let start = SharedSDK.MailListStart(
            areaId: "a", projectId: "p", box: .sempDrafts, mailboxId: "m", folderId: "f"
        )
        XCTAssertEqual(
            SharedMailFoldersScreenModel.effect(SharedSDK.MailFoldersEffectOpenList(start: start, title: "Klienti")),
            .openList(
                CoreKit.MailListStart(areaId: "a", projectId: "p", box: .sempDrafts, mailboxId: "m", folderId: "f"),
                title: "Klienti"
            )
        )
        XCTAssertEqual(SharedMailFoldersScreenModel.effect(SharedSDK.MailFoldersEffectCompose.shared), .compose)
        let accounts = SharedSDK.MailFoldersEffectOpenAccounts.shared
        XCTAssertEqual(SharedMailFoldersScreenModel.effect(accounts), .openAccounts)
        XCTAssertEqual(CoreKit.MailListStart(start).shared.folderId, "f")
    }

    // MARK: - Accounts
    @MainActor
    func testAccountsMapPhasesRowsAndConnectFailures() {
        XCTAssertEqual(SharedMailAccountsScreenModel.state(accountsState(.loading)).phase, .loading)
        XCTAssertEqual(SharedMailAccountsScreenModel.state(accountsState(.error)).phase, .failure(nil))
        let state = SharedMailAccountsScreenModel.state(accountsState(.content, failure: nil, connectFailure: .refused))
        let item = CoreKit.MailAccountItem(id: "m1", name: "Gmail", address: nil, provider: "gmail", status: .ok)
        XCTAssertEqual(state.accounts, [item])
        XCTAssertTrue(state.connecting)
        XCTAssertEqual(state.connectFailure, .refused)
        let failures: [(SharedSDK.MailConnectFailure, CoreKit.MailConnectFailure)] = [
            (.invalidInput, .invalidInput), (.refused, .refused),
            (.unavailable, .unavailable), (.unexpected, .unexpected)
        ]
        for (kotlin, swift) in failures {
            let state = SharedMailAccountsScreenModel.state(accountsState(.content, connectFailure: kotlin))
            XCTAssertEqual(state.connectFailure, swift)
        }
        XCTAssertNil(SharedMailAccountsScreenModel.state(accountsState(.content)).connectFailure)
    }

    @MainActor
    func testAccountsMapEachActionAndEffect() throws {
        XCTAssertTrue(SharedMailAccountsScreenModel.action(.retry) is SharedSDK.MailAccountsActionRetry)
        XCTAssertTrue(SharedMailAccountsScreenModel.action(.refresh) is SharedSDK.MailAccountsActionRefresh)
        let dismiss = SharedMailAccountsScreenModel.action(.dismissConnectFailure)
        XCTAssertTrue(dismiss is SharedSDK.MailAccountsActionDismissConnectFailure)
        let open = try XCTUnwrap(
            SharedMailAccountsScreenModel.action(.open(mailboxId: "m1")) as? SharedSDK.MailAccountsActionOpen
        )
        XCTAssertEqual(open.mailboxId, "m1")
        let kinds: [(CoreKit.MailConnectKind, SharedSDK.MailConnectKind)] = [(.icloud, .icloud), (.generic, .generic)]
        for (kind, kotlin) in kinds {
            let action = try XCTUnwrap(
                SharedMailAccountsScreenModel.action(
                    .connect(kind: kind, address: "a@x.cz", password: "pw", imapHost: "i", smtpHost: "s")
                ) as? SharedSDK.MailAccountsActionConnect
            )
            XCTAssertEqual(action.kind, kotlin)
            XCTAssertEqual(
                [action.address, action.password, action.imapHost, action.smtpHost],
                ["a@x.cz", "pw", "i", "s"]
            )
        }
        XCTAssertEqual(
            SharedMailAccountsScreenModel.effect(SharedSDK.MailAccountsEffectOpenAccount(mailboxId: "m1")),
            .openAccount(mailboxId: "m1")
        )
        XCTAssertEqual(SharedMailAccountsScreenModel.effect(SharedSDK.MailAccountsEffectConnected.shared), .connected)
    }

    // MARK: - Account
    @MainActor
    func testAccountMapsPhasesDetailAndRemoval() {
        XCTAssertEqual(SharedMailAccountScreenModel.state(accountState(.loading)).phase, .loading)
        let missing = SharedMailAccountScreenModel.state(accountState(.error, failure: .notFound))
        XCTAssertEqual(missing.phase, .failure(.notFound))
        let state = SharedMailAccountScreenModel.state(accountState(.content))
        XCTAssertEqual(
            state.account,
            CoreKit.MailAccountDetail(
                id: "m1", name: "Gmail", address: "me@gmail.com", provider: "gmail", syncMode: "imap",
                status: .needsReauthorization, lastSuccessfulSyncAt: "2026-10-19T08:12:00Z",
                failingSince: "2026-10-19T09:12:00Z", connectionLimit: 3, connectionLimitApplies: true,
                autonomousSendProjectCount: 1
            )
        )
        XCTAssertEqual(state.removal, .confirming)
        let impact = CoreKit.MailRemovalImpactItem(messages: 120, drafts: 2, threads: 50, attachmentsKept: 7)
        XCTAssertEqual(state.impact, impact)
        XCTAssertTrue(state.actionFailed)
        let phases: [(SharedSDK.MailRemovalPhase, CoreKit.MailRemovalPhase)] = [
            (.idle, .idle), (.loadingImpact, .loadingImpact), (.confirming, .confirming), (.removing, .removing)
        ]
        for (kotlin, swift) in phases {
            XCTAssertEqual(SharedMailAccountScreenModel.state(accountState(.content, removal: kotlin)).removal, swift)
        }
    }

    @MainActor
    func testAccountMapsEachActionAndEffect() throws {
        XCTAssertTrue(SharedMailAccountScreenModel.action(.retry) is SharedSDK.MailAccountActionRetry)
        XCTAssertTrue(SharedMailAccountScreenModel.action(.requestRemoval) is SharedSDK.MailAccountActionRequestRemoval)
        XCTAssertTrue(SharedMailAccountScreenModel.action(.cancelRemoval) is SharedSDK.MailAccountActionCancelRemoval)
        XCTAssertTrue(SharedMailAccountScreenModel.action(.confirmRemoval) is SharedSDK.MailAccountActionConfirmRemoval)
        XCTAssertTrue(SharedMailAccountScreenModel.action(.dismissFailure) is SharedSDK.MailAccountActionDismissFailure)
        let rename = try XCTUnwrap(
            SharedMailAccountScreenModel.action(.rename("Osobní")) as? SharedSDK.MailAccountActionRename
        )
        XCTAssertEqual(rename.name, "Osobní")
        let step = try XCTUnwrap(
            SharedMailAccountScreenModel.action(.stepConnectionLimit(delta: -1))
                as? SharedSDK.MailAccountActionStepConnectionLimit
        )
        XCTAssertEqual(step.delta, -1)
        XCTAssertEqual(SharedMailAccountScreenModel.effect(SharedSDK.MailAccountEffectRemoved.shared), .removed)
    }
}
