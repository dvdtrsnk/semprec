import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the thread bridge's mappings between Kotlin and Swift values with Kotlin values built here.
final class MailThreadMappingTests: XCTestCase {

    // MARK: - Thread
    @MainActor
    func testThreadMapsLoadingAndFailure() {
        XCTAssertEqual(SharedMailThreadScreenModel.state(threadState(.loading)).phase, .loading)
        XCTAssertEqual(
            SharedMailThreadScreenModel.state(threadState(.error, failure: .notFound)).phase,
            .failure(.notFound)
        )
        XCTAssertEqual(SharedMailThreadScreenModel.state(threadState(.error)).phase, .failure(nil))
    }

    @MainActor
    func testThreadMapsContentWithMessagesTasksLinksAndDraft() {
        let inherited = SharedSDK.MailLinkInfo(type: .inherited, sourceTitles: ["Petr"], brokenByAgent: false)
        let broken = SharedSDK.MailLinkInfo(type: .broken, sourceTitles: ["Web"], brokenByAgent: true)
        let derived = SharedSDK.MailLinkInfo(type: .derived, sourceTitles: [], brokenByAgent: false)
        let message = messageItem(attachments: [attachmentItem(link: derived)])
        let task = SharedSDK.MailTaskItem(
            id: "k1", name: "Poslat", date: "2026-10-23", done: true,
            project: SharedSDK.MailLinkedValue(text: "Web", link: nil), peopleNames: ["Petr"], peopleLink: broken
        )
        let state = SharedMailThreadScreenModel.state(
            threadState(
                .content,
                company: SharedSDK.MailLinkedValue(text: "Novák", link: inherited),
                messages: [message],
                tasks: [task],
                draft: SharedSDK.MailSempDraft(id: "d1", body: "Text", recipients: ["Petr"]),
                sendPhase: .failed,
                sendFailure: .rejected
            )
        )
        XCTAssertEqual(state.company, CoreKit.MailLinkedValue(
            text: "Novák", link: CoreKit.MailLinkInfo(type: .inherited, sourceTitles: ["Petr"], brokenByAgent: false)
        ))
        XCTAssertEqual(state.project, CoreKit.MailLinkedValue(text: nil, link: nil))
        XCTAssertEqual(state.messages.first?.attachments.first?.project.link?.type, .derived)
        XCTAssertEqual(state.messages.first?.attachments.first?.byteSize, 840)
        XCTAssertEqual(state.messages.first?.toNames, ["David"])
        let people = CoreKit.MailLinkInfo(type: .broken, sourceTitles: ["Web"], brokenByAgent: true)
        XCTAssertEqual(state.tasks.first?.peopleLink, people)
        XCTAssertEqual(state.tasks.first?.done, true)
        XCTAssertEqual(state.draft, CoreKit.MailSempDraft(id: "d1", body: "Text", recipients: ["Petr"]))
        XCTAssertEqual(state.sendPhase, .failed)
        XCTAssertEqual(state.sendFailure, .rejected)
        XCTAssertEqual(state.sentFrom, "Gmail")
        XCTAssertTrue(state.archivedOrTrashed && state.canReply && state.acting)
        XCTAssertTrue(state.creatingTask && state.actionFailed)
    }

    @MainActor
    func testThreadMapsEveryBodyPhaseWithItsPreviewAndWhyItFailed() {
        let phases: [(SharedSDK.MailBodyPhase, CoreKit.MailBodyPhase)] = [
            (.ready, .ready), (.remote, .remote), (.loading, .loading), (.failed, .failed)
        ]
        for (kotlin, swift) in phases {
            let message = messageItem(bodyPhase: kotlin)
            let state = SharedMailThreadScreenModel.state(threadState(.content, messages: [message]))
            XCTAssertEqual(state.messages.first?.bodyPhase, swift)
            XCTAssertEqual(state.messages.first?.preview, "Náhled")
        }
        let unfetched = messageItem(
            bodyText: "", bodyPhase: .failed, bodyFailure: .unavailable, bodyUnavailable: .rateLimited
        )
        let failed = SharedMailThreadScreenModel.state(threadState(.content, messages: [unfetched])).messages.first
        XCTAssertEqual(failed?.bodyFailure, .unavailable)
        XCTAssertEqual(failed?.bodyUnavailable, .rateLimited)
        XCTAssertEqual(failed?.bodyText, "")
        let ready = SharedMailThreadScreenModel.state(threadState(.content, messages: [messageItem()])).messages.first
        XCTAssertNil(ready?.bodyFailure)
        XCTAssertNil(ready?.bodyUnavailable)
    }

    @MainActor
    func testThreadMapsEverySavePhaseOfAnAttachmentWithItsFilesItemAndWhyItFailed() {
        let phases: [(SharedSDK.MailAttachmentSavePhase, CoreKit.MailAttachmentSavePhase)] = [
            (.idle, .idle), (.saving, .saving), (.saved, .saved), (.failed, .failed)
        ]
        for (kotlin, swift) in phases {
            let message = messageItem(attachments: [attachmentItem(savePhase: kotlin)])
            let state = SharedMailThreadScreenModel.state(threadState(.content, messages: [message]))
            XCTAssertEqual(state.messages.first?.attachments.first?.savePhase, swift)
        }
        let saved = messageItem(attachments: [attachmentItem(fileItemId: "f1", savePhase: .saved)])
        let file = SharedMailThreadScreenModel.state(threadState(.content, messages: [saved])).messages.first?
            .attachments.first
        XCTAssertEqual(file?.id, "a1")
        XCTAssertEqual(file?.fileItemId, "f1")
        XCTAssertNil(file?.saveFailure)
        let failed = messageItem(
            attachments: [
                attachmentItem(savePhase: .failed, saveFailure: .notFound, saveUnavailable: .attachmentTooLarge)
            ]
        )
        let refused = SharedMailThreadScreenModel.state(threadState(.content, messages: [failed])).messages.first?
            .attachments.first
        XCTAssertNil(refused?.fileItemId)
        XCTAssertEqual(refused?.saveFailure, .notFound)
        XCTAssertEqual(refused?.saveUnavailable, .attachmentTooLarge)
    }

    func testEveryReasonAProviderFetchFailsMapsToItsSwiftValue() {
        let reasons: [(SharedSDK.MailContentUnavailable, CoreKit.MailContentUnavailable)] = [
            (.reauthorizationRequired, .reauthorizationRequired),
            (.providerUnreachable, .providerUnreachable),
            (.messageNotFound, .messageNotFound),
            (.mailboxUnavailable, .mailboxUnavailable),
            (.attachmentTooLarge, .attachmentTooLarge),
            (.rateLimited, .rateLimited)
        ]
        XCTAssertEqual(reasons.count, CoreKit.MailContentUnavailable.allCases.count)
        for (kotlin, swift) in reasons {
            XCTAssertEqual(kotlin.unavailable, swift)
        }
    }

    @MainActor
    func testThreadMapsEverySendPhase() {
        let phases: [(SharedSDK.MailSendPhase, CoreKit.MailSendPhase)] = [
            (.idle, .idle), (.sending, .sending), (.sent, .sent), (.failed, .failed)
        ]
        for (kotlin, swift) in phases {
            XCTAssertEqual(SharedMailThreadScreenModel.state(threadState(.content, sendPhase: kotlin)).sendPhase, swift)
        }
    }

    @MainActor
    func testThreadMapsEachActionAndEffect() throws {
        XCTAssertTrue(SharedMailThreadScreenModel.action(.retry) is SharedSDK.MailThreadActionRetry)
        XCTAssertTrue(SharedMailThreadScreenModel.action(.refresh) is SharedSDK.MailThreadActionRefresh)
        XCTAssertTrue(SharedMailThreadScreenModel.action(.toggleFlag) is SharedSDK.MailThreadActionToggleFlag)
        XCTAssertTrue(SharedMailThreadScreenModel.action(.addTask) is SharedSDK.MailThreadActionAddTask)
        XCTAssertTrue(SharedMailThreadScreenModel.action(.dismissFailure) is SharedSDK.MailThreadActionDismissFailure)
        let toggle = try XCTUnwrap(
            SharedMailThreadScreenModel.action(.toggleMessage(emailId: "e1"))
                as? SharedSDK.MailThreadActionToggleMessage
        )
        XCTAssertEqual(toggle.emailId, "e1")
        let send = try XCTUnwrap(
            SharedMailThreadScreenModel.action(.sendDraft(body: "Text")) as? SharedSDK.MailThreadActionSendDraft
        )
        XCTAssertEqual(send.body, "Text")
        let load = try XCTUnwrap(
            SharedMailThreadScreenModel.action(.loadBody(emailId: "e2")) as? SharedSDK.MailThreadActionLoadBody
        )
        XCTAssertEqual(load.emailId, "e2")
        let save = try XCTUnwrap(
            SharedMailThreadScreenModel.action(.saveAttachment(emailId: "e3", attachmentId: "a1"))
                as? SharedSDK.MailThreadActionSaveAttachment
        )
        XCTAssertEqual(save.emailId, "e3")
        XCTAssertEqual(save.attachmentId, "a1")
        let moves: [(CoreKit.MailThreadMove, SharedSDK.MailThreadMove)] = [
            (.archive, .archive), (.trash, .trash), (.restore, .restore)
        ]
        for (move, kotlin) in moves {
            let action = try XCTUnwrap(
                SharedMailThreadScreenModel.action(.move(move)) as? SharedSDK.MailThreadActionMove
            )
            XCTAssertEqual(action.to, kotlin)
        }
    }

    @MainActor
    func testThreadTargetsMapToKotlin() throws {
        XCTAssertTrue(SharedMailThreadScreenModel.sharedTarget(.draft) is SharedSDK.MailThreadTargetDraft)
        let task = try XCTUnwrap(
            SharedMailThreadScreenModel.sharedTarget(.task(taskId: "k1")) as? SharedSDK.MailThreadTargetTask
        )
        XCTAssertEqual(task.taskId, "k1")
        let file = try XCTUnwrap(
            SharedMailThreadScreenModel.sharedTarget(.file(fileItemId: "f1")) as? SharedSDK.MailThreadTargetFile
        )
        XCTAssertEqual(file.fileItemId, "f1")
        let modes: [(CoreKit.MailReplyMode, SharedSDK.MailReplyMode)] = [
            (.reply, .reply), (.replyAll, .replyAll), (.forward, .forward)
        ]
        for (mode, kotlin) in modes {
            let reply = try XCTUnwrap(
                SharedMailThreadScreenModel.sharedTarget(.reply(mode)) as? SharedSDK.MailThreadTargetReply
            )
            XCTAssertEqual(reply.mode, kotlin)
            XCTAssertEqual(CoreKit.MailReplyMode(kotlin), mode)
        }
        let open = try XCTUnwrap(SharedMailThreadScreenModel.action(.open(.draft)) as? SharedSDK.MailThreadActionOpen)
        XCTAssertTrue(open.target is SharedSDK.MailThreadTargetDraft)
    }

    @MainActor
    func testThreadMapsEachEffect() {
        XCTAssertEqual(SharedMailThreadScreenModel.effect(SharedSDK.MailThreadEffectClose.shared), .close)
        XCTAssertEqual(
            SharedMailThreadScreenModel.effect(SharedSDK.MailThreadEffectOpenTask(taskId: "k1")),
            .openTask(taskId: "k1")
        )
        XCTAssertEqual(
            SharedMailThreadScreenModel.effect(SharedSDK.MailThreadEffectOpenFile(fileItemId: "f1")),
            .openFile(fileItemId: "f1")
        )
        let starts: [CoreKit.MailComposeStart] = [
            .new,
            .reply(sourceEmailId: "e1", mailboxId: "m1", mode: .forward),
            .draft(draftId: "d1")
        ]
        for start in starts {
            let effect = SharedSDK.MailThreadEffectCompose(start: start.shared)
            XCTAssertEqual(SharedMailThreadScreenModel.effect(effect), .compose(start))
        }
    }
}
