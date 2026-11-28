@preconcurrency internal import SharedSDK

/// The Kotlin `MailComposeViewModel` as a `MailComposeScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedMailComposeScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.MailComposeViewModel
    private let effectQueue: EffectQueue<MailComposeEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.MailComposeViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedMailComposeScreenModel: ScreenModel {

    var state: MailComposeState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<MailComposeState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<MailComposeEffect> {
        effectQueue.stream()
    }

    func send(_ action: MailComposeAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedMailComposeScreenModel {

    static func state(_ state: SharedSDK.MailComposeState) -> MailComposeState {
        MailComposeState(
            phase: phase(state),
            refusal: state.refusal.map(\.refusal),
            senders: state.senders.map { MailSender(mailboxId: $0.mailboxId, name: $0.name, address: $0.address) },
            senderId: state.senderId,
            toRecipients: state.to.map { MailRecipient(name: $0.name, address: $0.address) },
            ccRecipients: state.cc.map { MailRecipient(name: $0.name, address: $0.address) },
            initialSubject: state.initialSubject,
            initialBody: state.initialBody,
            suggestions: state.suggestions.map {
                MailSuggestion(name: $0.name, address: $0.address, relationship: $0.relationship)
            },
            invalidAddress: state.invalidAddress,
            sendPhase: MailSendPhase(state.sendPhase),
            sendFailure: state.sendFailure.map(FailureKind.init),
            sendRefusal: state.sendRefusal.map(\.refusal),
            sentFrom: state.sentFrom,
            discardFailed: state.discardFailed
        )
    }

    static func action(_ action: MailComposeAction) -> any SharedSDK.MailComposeAction {
        switch action {
        case .retry: SharedSDK.MailComposeActionRetry.shared
        case .searchContacts(let text): SharedSDK.MailComposeActionSearchContacts(text: text)
        case .addRecipient(let name, let address): SharedSDK.MailComposeActionAddRecipient(name: name, address: address)
        case .addAddress(let text): SharedSDK.MailComposeActionAddAddress(text: text)
        case .removeRecipient(let address): SharedSDK.MailComposeActionRemoveRecipient(address: address)
        case .selectSender(let id): SharedSDK.MailComposeActionSelectSender(mailboxId: id)
        case .send(let subject, let body): SharedSDK.MailComposeActionSend(subject: subject, body: body)
        case .cancel: SharedSDK.MailComposeActionCancel.shared
        }
    }

    static func effect(_ effect: any SharedSDK.MailComposeEffect) -> MailComposeEffect {
        switch onEnum(of: effect) {
        case .close: .close
        }
    }

    private static func phase(_ state: SharedSDK.MailComposeState) -> MailComposePhase {
        switch state.phase {
        case .loading: .loading
        case .editing: .editing
        case .error: .failure(state.failure.map(FailureKind.init))
        }
    }
}
