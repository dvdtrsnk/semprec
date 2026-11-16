@preconcurrency internal import SharedSDK

/// The Kotlin `MailFoldersViewModel` as a `MailFoldersScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedMailFoldersScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.MailFoldersViewModel
    private let effectQueue: EffectQueue<MailFoldersEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.MailFoldersViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedMailFoldersScreenModel: ScreenModel {

    var state: MailFoldersState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<MailFoldersState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<MailFoldersEffect> {
        effectQueue.stream()
    }

    func send(_ action: MailFoldersAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedMailFoldersScreenModel {

    static func state(_ state: SharedSDK.MailFoldersState) -> MailFoldersState {
        MailFoldersState(
            phase: phase(state),
            refreshing: state.refreshing,
            unreadInbox: Int(state.unreadInbox),
            flagged: Int(state.flagged),
            sempDrafts: Int(state.sempDrafts),
            accounts: state.accounts.map(account)
        )
    }

    static func action(_ action: MailFoldersAction) -> any SharedSDK.MailFoldersAction {
        switch action {
        case .retry: SharedSDK.MailFoldersActionRetry.shared
        case .refresh: SharedSDK.MailFoldersActionRefresh.shared
        case .toggleAccount(let id): SharedSDK.MailFoldersActionToggleAccount(mailboxId: id)
        case .openBox(let box): SharedSDK.MailFoldersActionOpenBox(box: box.shared)
        case .openFolder(let mailboxId, let folderId):
            SharedSDK.MailFoldersActionOpenFolder(mailboxId: mailboxId, folderId: folderId)
        case .compose: SharedSDK.MailFoldersActionCompose.shared
        case .openAccounts: SharedSDK.MailFoldersActionOpenAccounts.shared
        }
    }

    static func effect(_ effect: any SharedSDK.MailFoldersEffect) -> MailFoldersEffect {
        switch onEnum(of: effect) {
        case .openList(let open): .openList(MailListStart(open.start), title: open.title)
        case .compose: .compose
        case .openAccounts: .openAccounts
        }
    }

    private static func phase(_ state: SharedSDK.MailFoldersState) -> MailFoldersPhase {
        switch state.phase {
        case .loading: .loading
        case .content: .content
        case .error: .failure(state.failure.map(FailureKind.init))
        }
    }

    private static func account(_ account: SharedSDK.MailFolderAccount) -> MailFolderAccount {
        MailFolderAccount(
            id: account.id,
            name: account.name,
            address: account.address,
            status: MailAccountStatus(account.status),
            folders: account.folders.map {
                MailFolderItem(
                    id: $0.id,
                    name: $0.name,
                    specialPurpose: $0.specialPurpose,
                    unreadCount: Int($0.unreadCount)
                )
            },
            foldersFailed: account.foldersFailed,
            collapsed: account.collapsed
        )
    }
}
