@preconcurrency internal import SharedSDK

/// The Kotlin `MailThreadViewModel` as a `MailThreadScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedMailThreadScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.MailThreadViewModel
    private let effectQueue: EffectQueue<MailThreadEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.MailThreadViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedMailThreadScreenModel: ScreenModel {

    var state: MailThreadState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<MailThreadState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<MailThreadEffect> {
        effectQueue.stream()
    }

    func send(_ action: MailThreadAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedMailThreadScreenModel {

    static func state(_ state: SharedSDK.MailThreadState) -> MailThreadState {
        MailThreadState(
            phase: phase(state),
            refreshing: state.refreshing,
            subject: state.subject,
            senderName: state.senderName,
            senderAddress: state.senderAddress,
            senderRelationship: state.senderRelationship,
            mailboxNames: state.mailboxNames,
            messageCount: Int(state.messageCount),
            flagged: state.flagged,
            company: MailLinkedValue(state.company),
            project: MailLinkedValue(state.project),
            messages: state.messages.map(message),
            tasks: state.tasks.map(task),
            draft: state.draft.map { MailSempDraft(id: $0.id, body: $0.body, recipients: $0.recipients) },
            sendPhase: MailSendPhase(state.sendPhase),
            sendFailure: state.sendFailure.map(FailureKind.init),
            sendRefusal: state.sendRefusal.map(\.refusal),
            sentFrom: state.sentFrom,
            archivedOrTrashed: state.archivedOrTrashed,
            canReply: state.canReply,
            acting: state.acting,
            creatingTask: state.creatingTask,
            actionFailed: state.actionFailed,
            actionRefusal: state.actionRefusal.map(\.refusal)
        )
    }

    static func action(_ action: MailThreadAction) -> any SharedSDK.MailThreadAction {
        switch action {
        case .retry: SharedSDK.MailThreadActionRetry.shared
        case .refresh: SharedSDK.MailThreadActionRefresh.shared
        case .toggleMessage(let id): SharedSDK.MailThreadActionToggleMessage(emailId: id)
        case .toggleFlag: SharedSDK.MailThreadActionToggleFlag.shared
        case .move(let move): SharedSDK.MailThreadActionMove(to: sharedMove(move))
        case .sendDraft(let body): SharedSDK.MailThreadActionSendDraft(body: body)
        case .addTask: SharedSDK.MailThreadActionAddTask.shared
        case .open(let target): SharedSDK.MailThreadActionOpen(target: sharedTarget(target))
        case .dismissFailure: SharedSDK.MailThreadActionDismissFailure.shared
        }
    }

    static func effect(_ effect: any SharedSDK.MailThreadEffect) -> MailThreadEffect {
        switch onEnum(of: effect) {
        case .close: .close
        case .compose(let compose): .compose(MailComposeStart(compose.start))
        case .openTask(let task): .openTask(taskId: task.taskId)
        }
    }

    static func sharedTarget(_ target: MailThreadTarget) -> any SharedSDK.MailThreadTarget {
        switch target {
        case .draft: SharedSDK.MailThreadTargetDraft.shared
        case .reply(let mode): SharedSDK.MailThreadTargetReply(mode: mode.shared)
        case .task(let id): SharedSDK.MailThreadTargetTask(taskId: id)
        }
    }

    private static func sharedMove(_ move: MailThreadMove) -> SharedSDK.MailThreadMove {
        switch move {
        case .archive: .archive
        case .trash: .trash
        case .restore: .restore
        }
    }

    private static func phase(_ state: SharedSDK.MailThreadState) -> MailThreadPhase {
        switch state.phase {
        case .loading: .loading
        case .content: .content
        case .error: .failure(state.failure.map(FailureKind.init))
        }
    }

    private static func message(_ item: SharedSDK.MailMessageItem) -> MailMessageItem {
        MailMessageItem(
            emailId: item.emailId,
            fromName: item.fromName,
            fromAddress: item.fromAddress,
            own: item.own,
            toNames: item.toNames,
            date: item.date,
            bodyText: item.bodyText,
            attachments: item.attachments.map(attachment),
            expanded: item.expanded
        )
    }

    private static func attachment(_ item: SharedSDK.MailAttachmentItem) -> MailAttachmentItem {
        MailAttachmentItem(
            filename: item.filename,
            contentType: item.contentType,
            byteSize: item.byteSize,
            project: MailLinkedValue(item.project)
        )
    }

    private static func task(_ item: SharedSDK.MailTaskItem) -> MailTaskItem {
        MailTaskItem(
            id: item.id,
            name: item.name,
            date: item.date,
            done: item.done,
            project: MailLinkedValue(item.project),
            peopleNames: item.peopleNames,
            peopleLink: item.peopleLink.map(MailLinkInfo.init)
        )
    }
}
