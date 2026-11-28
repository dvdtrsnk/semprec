import CoreKit
import NavigatorUI
import SwiftUI
import XCTest

@testable import Alldots

/// What the Mail screens do in the app: the router changes the stack of its tab, and the real scene shows the screen of
/// each mail destination.
final class MailNavigationTests: XCTestCase {

    // MARK: - Router
    @MainActor
    func testTheRouterPushesEveryMailScreenOntoTheStackOfItsTabAndOpensTheAccountsInTheSettings() {
        let context = NavigationContext()
        let calendar = MailStackSpy()
        let overview = MailStackSpy()
        context.register(calendar, for: .calendar)
        context.register(overview, for: .overview)
        let router = AppMailRouter(context: context, tab: .calendar)
        let start = MailListStart(mailboxId: "m1", folderId: "f1")
        router.showList(start, title: "Klienti")
        router.showThread(threadId: "t1")
        router.showFolders()
        router.showAccounts()
        router.showAccount(mailboxId: "m1")
        XCTAssertEqual(
            calendar.pushed,
            [
                .mailList(start, title: "Klienti", tab: .calendar),
                .mailThread(threadId: "t1", tab: .calendar),
                .mailFolders(tab: .calendar)
            ]
        )
        XCTAssertEqual(
            calendar.sheets,
            [
                .profile(opening: [.page(.internetAccounts)]),
                .profile(opening: [.page(.internetAccounts), .internetAccount(accountId: "m1")])
            ]
        )
        XCTAssertTrue(overview.pushed.isEmpty)
    }

    @MainActor
    func testTheEditorTheTaskAndAFileOfAThreadArePresentedAsSheetsOverTheStack() {
        let context = NavigationContext()
        let overview = MailStackSpy()
        context.register(overview, for: .overview)
        let router = AppMailRouter(context: context, tab: .overview)
        let reply = MailComposeStart.reply(sourceEmailId: "e1", mailboxId: "m1", mode: .replyAll)
        router.showCompose(.new)
        router.showCompose(reply)
        router.showTask(taskId: "k1")
        router.showFile(fileItemId: "f1")
        XCTAssertEqual(
            overview.sheets,
            [
                .mailCompose(.new),
                .mailCompose(reply),
                .details(ItemDetailsTarget(kind: .task, id: "k1")),
                .itemSheet(itemId: "f1", databaseKey: "files", tab: .overview)
            ]
        )
        XCTAssertTrue(overview.pushed.isEmpty)
    }

    @MainActor
    func testTheContextShowsAllMailAndTheMailOfAProjectOnTheStackOfATab() {
        let context = NavigationContext()
        let journal = MailStackSpy()
        context.register(journal, for: .journal)
        context.showMail(MailListStart(), in: .journal)
        context.showMail(MailListStart(projectId: "p1"), title: nil, in: .journal)
        XCTAssertEqual(
            journal.pushed,
            [
                .mailList(MailListStart(), title: nil, tab: .journal),
                .mailList(MailListStart(projectId: "p1"), title: nil, tab: .journal)
            ]
        )
    }

    // MARK: - Scene
    @MainActor
    func testTheSceneShowsTheThreadListAndAThreadOnTheStackOfTheTab() async throws {
        let window = try SceneWindow()
        let scene = AppComposition(models: SignedInModels())
        try await window.show(AppScene(composition: scene))
        try await eventually { scene.navigation.stack(for: .overview) != nil }

        scene.navigation.showMail(MailListStart(), in: .overview)
        try await eventually { window.stackTitle == "Mail" }
        XCTAssertEqual(window.stackTitle, "Mail")
        scene.navigation.push(.mailThread(threadId: "t1", tab: .overview), in: .overview)
        try await eventually { window.stackTitle == "Thread" }
        XCTAssertEqual(window.stackTitle, "Thread")
        window.close()
    }

    @MainActor
    func testTheSceneShowsTheMailboxesAndOpensTheInternetAccountsInTheSettingsSheet() async throws {
        let window = try SceneWindow()
        let scene = AppComposition(models: SignedInModels())
        try await window.show(AppScene(composition: scene))
        try await eventually { scene.navigation.stack(for: .overview) != nil }

        scene.navigation.push(.mailFolders(tab: .overview), in: .overview)
        try await eventually { window.stackTitle == "Mailboxes" }
        XCTAssertEqual(window.stackTitle, "Mailboxes")
        let overview = try XCTUnwrap(scene.navigation.stack(for: .overview) as? NavigatorStackAdapter)
        scene.mailRouter(in: .overview).showAccounts()
        XCTAssertEqual(
            overview.navigator.presentingSheetOrCover as? AppDestination,
            .profile(opening: [.page(.internetAccounts)])
        )
        try await eventually { window.presentsSheet }
        XCTAssertTrue(window.presentsSheet, "The accounts must open in the settings sheet")
        XCTAssertEqual(window.stackTitle, "Mailboxes", "The Overview stack keeps the mailboxes under the sheet")
        window.close()
    }

    @MainActor
    func testTheSceneShowsTheMailSignalsOfAProjectOnTheStackOfItsTab() async throws {
        let window = try SceneWindow()
        let scene = AppComposition(models: SignedInModels())
        try await window.show(AppScene(composition: scene))
        try await eventually { scene.navigation.stack(for: .overview) != nil }

        scene.collectionsRouter.showProjectMailSignals(projectId: "p1")
        try await eventually { window.stackTitle == "Mail signals" }
        XCTAssertEqual(window.stackTitle, "Mail signals")
        XCTAssertFalse(window.presentsSheet)
        window.close()
    }

    @MainActor
    func testTheSceneShowsTheEditorAsASheet() async throws {
        let window = try SceneWindow()
        let scene = AppComposition(models: SignedInModels())
        try await window.show(AppScene(composition: scene))
        try await eventually { scene.navigation.stack(for: .overview) != nil }

        scene.navigation.presentSheet(.mailCompose(.new), from: .overview)
        try await eventually { window.presentsSheet }
        XCTAssertTrue(window.presentsSheet, "The window must show the editor as a sheet")
        window.close()
    }
}

// MARK: - Spies
@MainActor
private final class MailStackSpy {

    // MARK: - Properties
    var pushed: [AppDestination] = []
    var sheets: [AppDestination] = []
}

// MARK: - Protocol conformance
extension MailStackSpy: StackNavigating {

    var top: AppDestination? { pushed.last }

    func push(_ destination: AppDestination) {
        pushed.append(destination)
    }

    func presentSheet(_ destination: AppDestination) {
        sheets.append(destination)
    }

    func dismissPresented() {}
}
