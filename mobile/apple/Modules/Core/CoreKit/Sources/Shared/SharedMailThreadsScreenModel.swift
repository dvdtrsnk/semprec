@preconcurrency internal import SharedSDK

/// The Kotlin `MailThreadsViewModel` as a `MailThreadsScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedMailThreadsScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.MailThreadsViewModel
    private let effectQueue: EffectQueue<MailThreadsEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.MailThreadsViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedMailThreadsScreenModel: ScreenModel {

    var state: MailThreadsState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<MailThreadsState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<MailThreadsEffect> {
        effectQueue.stream()
    }

    func send(_ action: MailThreadsAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedMailThreadsScreenModel {

    static func state(_ state: SharedSDK.MailThreadsState) -> MailThreadsState {
        MailThreadsState(
            phase: phase(state),
            refreshing: state.refreshing,
            loadingMore: state.loadingMore,
            hasMore: state.hasMore,
            threads: state.threads.map(thread),
            search: state.search,
            box: MailListBox(state.box),
            filter: filter(state.filter),
            mailboxId: state.mailboxId,
            folderId: state.folderId,
            areaId: state.areaId,
            projectId: state.projectId,
            areaName: state.areaName,
            projectName: state.projectName,
            mailboxes: state.mailboxes.map { MailMailboxChip(id: $0.id, name: $0.name) },
            reauthorization: state.reauthorization.map { MailAccountNotice(id: $0.id, name: $0.name, since: $0.since) },
            facets: facets(state.facets),
            actionFailed: state.actionFailed,
            actionRefusal: state.actionRefusal.map(\.refusal)
        )
    }

    static func action(_ action: MailThreadsAction) -> any SharedSDK.MailThreadsAction {
        switch action {
        case .retry: SharedSDK.MailThreadsActionRetry.shared
        case .refresh: SharedSDK.MailThreadsActionRefresh.shared
        case .loadMore: SharedSDK.MailThreadsActionLoadMore.shared
        case .search(let text): SharedSDK.MailThreadsActionSearch(text: text)
        case .selectFilter(let filter): SharedSDK.MailThreadsActionSelectFilter(filter: sharedFilter(filter))
        case .selectMailbox(let id): SharedSDK.MailThreadsActionSelectMailbox(mailboxId: id)
        case .setArea(let id): SharedSDK.MailThreadsActionSetArea(areaId: id)
        case .setProject(let id): SharedSDK.MailThreadsActionSetProject(projectId: id)
        case .clearContext: SharedSDK.MailThreadsActionClearContext.shared
        case .toggleRead(let id): SharedSDK.MailThreadsActionToggleRead(threadId: id)
        case .dismissFailure: SharedSDK.MailThreadsActionDismissFailure.shared
        case .open(let target): SharedSDK.MailThreadsActionOpen(target: sharedEffect(target))
        }
    }

    static func effect(_ effect: any SharedSDK.MailThreadsEffect) -> MailThreadsEffect {
        switch onEnum(of: effect) {
        case .openThread(let open): .openThread(threadId: open.threadId)
        case .openFolders: .openFolders
        case .compose: .compose
        case .openAccount(let open): .openAccount(mailboxId: open.mailboxId)
        }
    }

    static func sharedEffect(_ effect: MailThreadsEffect) -> any SharedSDK.MailThreadsEffect {
        switch effect {
        case .openThread(let id): SharedSDK.MailThreadsEffectOpenThread(threadId: id)
        case .openFolders: SharedSDK.MailThreadsEffectOpenFolders.shared
        case .compose: SharedSDK.MailThreadsEffectCompose.shared
        case .openAccount(let id): SharedSDK.MailThreadsEffectOpenAccount(mailboxId: id)
        }
    }

    private static func phase(_ state: SharedSDK.MailThreadsState) -> MailThreadsPhase {
        switch state.phase {
        case .loading: .loading
        case .content: .content
        case .error: .failure(state.failure.map(FailureKind.init))
        }
    }

    private static func filter(_ filter: SharedSDK.MailListFilter) -> MailListFilter {
        switch filter {
        case .all: .all
        case .unread: .unread
        case .flagged: .flagged
        }
    }

    private static func sharedFilter(_ filter: MailListFilter) -> SharedSDK.MailListFilter {
        switch filter {
        case .all: .all
        case .unread: .unread
        case .flagged: .flagged
        }
    }

    private static func thread(_ item: SharedSDK.MailThreadItem) -> MailThreadItem {
        MailThreadItem(
            threadId: item.threadId,
            subject: item.subject,
            lastMessageAt: item.lastMessageAt,
            senderName: item.senderName,
            senderAddress: item.senderAddress,
            senderRelationship: item.senderRelationship,
            messageCount: Int(item.messageCount),
            preview: item.preview,
            hasAttachment: item.hasAttachment,
            unread: item.unread,
            flagged: item.flagged,
            mailboxNames: item.mailboxNames,
            projectName: item.projectName,
            companyName: item.companyName,
            hasSempDraft: item.hasSempDraft
        )
    }

    private static func facets(_ facets: SharedSDK.MailFacetsState) -> MailFacetsState {
        MailFacetsState(
            phase: facetsPhase(facets.phase),
            areaTotal: Int(facets.areaTotal),
            projectTotal: Int(facets.projectTotal),
            areas: facets.areas.map(option),
            projects: facets.projects.map(option)
        )
    }

    private static func facetsPhase(_ phase: SharedSDK.MailFacetsPhase) -> MailFacetsPhase {
        switch phase {
        case .idle: .idle
        case .loading: .loading
        case .ready: .ready
        case .error: .error
        }
    }

    private static func option(_ option: SharedSDK.MailFilterOption) -> MailFilterOption {
        MailFilterOption(
            id: option.id,
            name: option.name,
            color: option.color,
            count: Int(option.count),
            areaId: option.areaId
        )
    }
}
