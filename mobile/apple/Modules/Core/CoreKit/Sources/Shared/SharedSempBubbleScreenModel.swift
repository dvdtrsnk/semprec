@preconcurrency internal import SharedSDK

/// The Kotlin `SempBubbleViewModel` as a `SempBubbleScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedSempBubbleScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.SempBubbleViewModel
    private let effectQueue: EffectQueue<SempBubbleEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.SempBubbleViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedSempBubbleScreenModel: ScreenModel {

    var state: SempBubbleState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<SempBubbleState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<SempBubbleEffect> {
        effectQueue.stream()
    }

    func send(_ action: SempBubbleAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedSempBubbleScreenModel {

    static func state(_ state: SharedSDK.SempBubbleState) -> SempBubbleState {
        SempBubbleState(
            badge: Int(state.badge),
            attachments: Int(state.attachments),
            toast: state.toast.map(SempBubbleToast.init)
        )
    }

    static func action(_ action: SempBubbleAction) -> any SharedSDK.SempBubbleAction {
        switch action {
        case .refresh: SharedSDK.SempBubbleActionRefresh.shared
        case .drop(let target): SharedSDK.SempBubbleActionDrop(target: target.shared)
        }
    }

    static func effect(_ effect: any SharedSDK.SempBubbleEffect) -> SempBubbleEffect {
        switch onEnum(of: effect) {
        case .openItemThread(let open):
            .openItemThread(inboxItemId: open.inboxItemId, title: open.title, meta: open.meta)
        }
    }
}

extension SempBubbleToast {

    init(_ toast: SharedSDK.SempBubbleToast) {
        switch toast {
        case .added: self = .added
        case .alreadyAdded: self = .alreadyAdded
        case .cannotAdd: self = .cannotAdd
        case .newThread: self = .newThread
        case .continueThread: self = .continueThread
        }
    }
}
