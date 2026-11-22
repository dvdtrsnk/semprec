import SharedSDK
import XCTest

@testable import CoreKit

// MARK: - Kotlin values for the mail mapping tests
extension XCTestCase {

    func threadsState(
        _ phase: SharedSDK.MailThreadsPhase,
        failure: SharedSDK.FailureKind? = nil,
        refreshing: Bool = false,
        hasMore: Bool = false,
        threads: [SharedSDK.MailThreadItem] = [],
        box: SharedSDK.MailListBox = .inbox,
        filter: SharedSDK.MailListFilter = .all,
        facets: SharedSDK.MailFacetsState = SharedSDK.MailFacetsState(
            phase: .idle, areaTotal: 0, projectTotal: 0, areas: [], projects: []
        ),
        remoteSearch: SharedSDK.MailRemoteSearchSummary? = nil,
        actionRefusal: SharedSDK.MailRefusal? = nil
    ) -> SharedSDK.MailThreadsState {
        SharedSDK.MailThreadsState(
            phase: phase,
            failure: failure,
            refreshing: refreshing,
            loadingMore: false,
            hasMore: hasMore,
            threads: threads,
            search: "from:petr",
            box: box,
            filter: filter,
            mailboxId: "m1",
            folderId: "f1",
            areaId: "a1",
            projectId: "p1",
            areaName: "Práce",
            projectName: "Web",
            mailboxes: [SharedSDK.MailMailboxChip(id: "m1", name: "Gmail")],
            reauthorization: [SharedSDK.MailAccountNotice(id: "m2", name: "Outlook", since: "2026-10-19T09:12:00Z")],
            facets: facets,
            remoteSearch: remoteSearch,
            actionFailed: true,
            actionRefusal: actionRefusal
        )
    }

    func messageItem(
        bodyText: String = "Ahoj",
        bodyPhase: SharedSDK.MailBodyPhase = .ready,
        bodyFailure: SharedSDK.FailureKind? = nil,
        bodyUnavailable: SharedSDK.MailContentUnavailable? = nil,
        attachments: [SharedSDK.MailAttachmentItem] = []
    ) -> SharedSDK.MailMessageItem {
        SharedSDK.MailMessageItem(
            emailId: "e1", fromName: "Petr", fromAddress: "p@x.cz", own: true, toNames: ["David"],
            date: "2026-10-20T12:41:00Z", bodyText: bodyText, preview: "Náhled", bodyPhase: bodyPhase,
            bodyFailure: bodyFailure, bodyUnavailable: bodyUnavailable, attachments: attachments, expanded: true
        )
    }

    func attachmentItem(
        link: SharedSDK.MailLinkInfo? = nil,
        fileItemId: String? = nil,
        savePhase: SharedSDK.MailAttachmentSavePhase = .idle,
        saveFailure: SharedSDK.FailureKind? = nil,
        saveUnavailable: SharedSDK.MailContentUnavailable? = nil
    ) -> SharedSDK.MailAttachmentItem {
        SharedSDK.MailAttachmentItem(
            attachmentId: "a1", filename: "a.pdf", contentType: "application/pdf", byteSize: 840,
            project: SharedSDK.MailLinkedValue(text: "Web", link: link), fileItemId: fileItemId,
            savePhase: savePhase, saveFailure: saveFailure, saveUnavailable: saveUnavailable
        )
    }

    func threadState(
        _ phase: SharedSDK.MailThreadPhase,
        failure: SharedSDK.FailureKind? = nil,
        company: SharedSDK.MailLinkedValue = SharedSDK.MailLinkedValue(text: nil, link: nil),
        messages: [SharedSDK.MailMessageItem] = [],
        tasks: [SharedSDK.MailTaskItem] = [],
        draft: SharedSDK.MailSempDraft? = nil,
        sendPhase: SharedSDK.MailSendPhase = .idle,
        sendFailure: SharedSDK.FailureKind? = nil,
        sendRefusal: SharedSDK.MailRefusal? = nil,
        actionRefusal: SharedSDK.MailRefusal? = nil
    ) -> SharedSDK.MailThreadState {
        SharedSDK.MailThreadState(
            phase: phase,
            failure: failure,
            refreshing: false,
            subject: "Re: Nabídka",
            senderName: "Petr",
            senderAddress: "p@x.cz",
            senderRelationship: "Klient",
            mailboxNames: ["Gmail"],
            messageCount: 3,
            flagged: true,
            company: company,
            project: SharedSDK.MailLinkedValue(text: nil, link: nil),
            messages: messages,
            tasks: tasks,
            draft: draft,
            sendPhase: sendPhase,
            sendFailure: sendFailure,
            sendRefusal: sendRefusal,
            sentFrom: "Gmail",
            archivedOrTrashed: true,
            canReply: true,
            acting: true,
            creatingTask: true,
            actionFailed: true,
            actionRefusal: actionRefusal
        )
    }

    func composeState(
        _ phase: SharedSDK.MailComposePhase,
        failure: SharedSDK.FailureKind? = nil,
        refusal: SharedSDK.MailRefusal? = nil,
        sendRefusal: SharedSDK.MailRefusal? = nil
    ) -> SharedSDK.MailComposeState {
        SharedSDK.MailComposeState(
            phase: phase,
            failure: failure,
            refusal: refusal,
            senders: [SharedSDK.MailSender(mailboxId: "m1", name: "Gmail", address: "me@gmail.com")],
            senderId: "m1",
            to: [SharedSDK.MailRecipient(name: "Petr", address: "p@x.cz")],
            cc: [SharedSDK.MailRecipient(name: "", address: "c@x.cz")],
            initialSubject: "Re",
            initialBody: "Text",
            suggestions: [SharedSDK.MailSuggestion(name: "Jana", address: "j@x.cz", relationship: "Přítel")],
            invalidAddress: true,
            sendPhase: .sent,
            sendFailure: .rejected,
            sendRefusal: sendRefusal,
            sentFrom: "Gmail",
            discardFailed: true
        )
    }

    func foldersState(
        _ phase: SharedSDK.MailFoldersPhase,
        failure: SharedSDK.FailureKind? = nil
    ) -> SharedSDK.MailFoldersState {
        SharedSDK.MailFoldersState(
            phase: phase,
            failure: failure,
            refreshing: false,
            unreadInbox: 5,
            flagged: 2,
            sempDrafts: 1,
            accounts: [
                SharedSDK.MailFolderAccount(
                    id: "m1",
                    name: "Gmail",
                    address: "me@gmail.com",
                    status: .syncing,
                    folders: [
                        SharedSDK.MailFolderItem(id: "f1", name: "Inbox", specialPurpose: "inbox", unreadCount: 3)
                    ],
                    foldersFailed: true,
                    collapsed: true
                )
            ]
        )
    }
}
