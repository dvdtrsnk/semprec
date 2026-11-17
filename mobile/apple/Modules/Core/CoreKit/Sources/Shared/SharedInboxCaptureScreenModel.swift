@preconcurrency internal import SharedSDK

/// The Kotlin `InboxCaptureViewModel` as an `InboxCaptureScreenModel`. Releasing the bridge closes the Kotlin
/// ViewModel.
@MainActor
final class SharedInboxCaptureScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.InboxCaptureViewModel
    private let effectQueue: EffectQueue<InboxCaptureEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.InboxCaptureViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedInboxCaptureScreenModel: ScreenModel {

    var state: InboxCaptureState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<InboxCaptureState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<InboxCaptureEffect> {
        effectQueue.stream()
    }

    func send(_ action: InboxCaptureAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedInboxCaptureScreenModel {

    static func state(_ state: SharedSDK.InboxCaptureState) -> InboxCaptureState {
        InboxCaptureState(
            types: state.types.map { InboxCaptureType(id: $0.id, label: $0.label, emoji: $0.emoji) },
            typesPhase: phase(state.typesPhase),
            typeId: state.typeId,
            attachment: state.attachment.map {
                InboxCaptureAttachment(filename: $0.filename, mimeType: $0.mimeType, byteSize: Int($0.byteSize))
            },
            sending: state.sending,
            failure: state.failure.map(Failed.init)
        )
    }

    static func phase(_ phase: SharedSDK.InboxCapturePhase) -> InboxCapturePhase {
        switch phase {
        case .idle: .idle
        case .loading: .loading
        case .ready: .ready
        case .failed: .failed
        }
    }

    static func action(_ action: InboxCaptureAction) -> any SharedSDK.InboxCaptureAction {
        switch action {
        case .loadTypes: SharedSDK.InboxCaptureActionLoadTypes.shared
        case .pickType(let typeId): SharedSDK.InboxCaptureActionPickType(typeId: typeId)
        case .attach(let filename, let mimeType, let base64, let source):
            SharedSDK.InboxCaptureActionAttach(
                filename: filename,
                mimeType: mimeType,
                base64: base64,
                source: Self.source(source)
            )
        case .removeAttachment: SharedSDK.InboxCaptureActionRemoveAttachment.shared
        case .submit(let text, let day, let time): SharedSDK.InboxCaptureActionSubmit(text: text, day: day, time: time)
        case .dismissFailure: SharedSDK.InboxCaptureActionDismissFailure.shared
        }
    }

    static func source(_ source: InboxCaptureSource) -> SharedSDK.InboxCaptureAttachmentSource {
        switch source {
        case .camera: .camera
        case .photoLibrary: .photoLibrary
        case .files: .files
        }
    }

    static func effect(_ effect: any SharedSDK.InboxCaptureEffect) -> InboxCaptureEffect {
        switch onEnum(of: effect) {
        case .captured: .captured
        }
    }
}
