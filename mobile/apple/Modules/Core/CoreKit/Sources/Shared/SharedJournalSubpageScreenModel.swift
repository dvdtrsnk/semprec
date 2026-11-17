@preconcurrency internal import SharedSDK

/// The Kotlin `JournalSubpageViewModel` as a `JournalSubpageScreenModel`. Releasing the bridge closes the Kotlin
/// ViewModel.
@MainActor
final class SharedJournalSubpageScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.JournalSubpageViewModel
    private let effectQueue: EffectQueue<JournalSubpageEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.JournalSubpageViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedJournalSubpageScreenModel: ScreenModel {

    var state: JournalSubpageState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<JournalSubpageState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<JournalSubpageEffect> {
        effectQueue.stream()
    }

    func send(_ action: JournalSubpageAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedJournalSubpageScreenModel {

    static func state(_ state: SharedSDK.JournalSubpageState) -> JournalSubpageState {
        JournalSubpageState(
            phase: JournalPhase(state.phase, failure: state.failure),
            blocks: state.blocks.map(JournalBlock.init),
            saving: state.saving,
            editProblem: JournalEditProblem(state.editProblem, failure: state.editFailure)
        )
    }

    static func action(_ action: JournalSubpageAction) -> any SharedSDK.JournalSubpageAction {
        switch action {
        case .retry: SharedSDK.JournalSubpageActionRetry.shared
        case .setText(let index, let text): SharedSDK.JournalSubpageActionSetText(index: Int32(index), text: text)
        case .toggleDone(let index): SharedSDK.JournalSubpageActionToggleDone(index: Int32(index))
        case .addBlock(let kind, let text): SharedSDK.JournalSubpageActionAddBlock(kind: kind.shared, text: text)
        case .openPage(let pageId, let title): SharedSDK.JournalSubpageActionOpenPage(pageId: pageId, title: title)
        case .dismissProblem: SharedSDK.JournalSubpageActionDismissProblem.shared
        }
    }

    static func effect(_ effect: any SharedSDK.JournalSubpageEffect) -> JournalSubpageEffect {
        switch onEnum(of: effect) {
        case .openPage(let openPage): .openPage(pageId: openPage.pageId, title: openPage.title)
        }
    }
}
