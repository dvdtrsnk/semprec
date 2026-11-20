import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the compose and mailboxes bridges' mappings between Kotlin and Swift
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
}
