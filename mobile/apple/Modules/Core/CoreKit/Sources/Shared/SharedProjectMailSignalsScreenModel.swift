@preconcurrency internal import SharedSDK

/// The Kotlin `ProjectMailSignalsViewModel` as a `ProjectMailSignalsScreenModel`. Releasing the bridge closes the
/// Kotlin ViewModel.
@MainActor
final class SharedProjectMailSignalsScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.ProjectMailSignalsViewModel
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.ProjectMailSignalsViewModel) {
        self.viewModel = viewModel
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedProjectMailSignalsScreenModel: ScreenModel {

    var state: ProjectMailSignalsState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<ProjectMailSignalsState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    /// The Kotlin ViewModel's effect type is `Nothing`, so the stream has no elements.
    func effects() -> AsyncStream<Never> {
        AsyncStream { $0.finish() }
    }

    func send(_ action: ProjectMailSignalsAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedProjectMailSignalsScreenModel {

    static func state(_ state: SharedSDK.ProjectMailSignalsState) -> ProjectMailSignalsState {
        ProjectMailSignalsState(
            phase: phase(state.phase),
            failure: state.failure.map(FailureKind.init),
            people: state.people.map {
                MailSignalPersonItem(personId: $0.personId, name: $0.name, address: $0.address)
            },
            domains: state.domains,
            addresses: state.addresses,
            keywords: state.keywords,
            domainInput: state.domainInput,
            addressInput: state.addressInput,
            keywordInput: state.keywordInput,
            invalidField: state.invalidField.map(field),
            unsaved: state.unsaved,
            saving: state.saving,
            saveFailure: state.saveFailure.map(Failed.init),
            preview: preview(state.preview),
            assigning: state.assigning,
            assignFailure: state.assignFailure.map(Failed.init),
            assignment: state.assignment.map {
                MailSignalsAssignment(assigned: Int($0.assigned), skipped: Int($0.skipped))
            },
            canSave: state.canSave,
            canAssign: state.canAssign
        )
    }

    static func phase(_ phase: SharedSDK.ProjectMailSignalsPhase) -> ProjectMailSignalsPhase {
        switch phase {
        case .loading: .loading
        case .ready: .ready
        case .error: .error
        }
    }

    static func preview(_ preview: SharedSDK.MailSignalsPreviewState) -> MailSignalsPreviewState {
        MailSignalsPreviewState(
            phase: previewPhase(preview.phase),
            failure: preview.failure.map(FailureKind.init),
            total: Int(preview.total),
            alreadyAssigned: Int(preview.alreadyAssigned),
            threads: preview.threads.map {
                MailSignalThreadItem(
                    threadId: $0.threadId,
                    subject: $0.subject,
                    senderName: $0.senderName,
                    senderAddress: $0.senderAddress,
                    lastMessageAt: $0.lastMessageAt
                )
            }
        )
    }

    static func previewPhase(_ phase: SharedSDK.MailSignalsPreviewPhase) -> MailSignalsPreviewPhase {
        switch phase {
        case .loading: .loading
        case .ready: .ready
        case .error: .error
        }
    }

    static func field(_ field: SharedSDK.MailSignalField) -> MailSignalField {
        switch field {
        case .domains: .domains
        case .addresses: .addresses
        case .keywords: .keywords
        }
    }

    static func field(_ field: MailSignalField) -> SharedSDK.MailSignalField {
        switch field {
        case .domains: .domains
        case .addresses: .addresses
        case .keywords: .keywords
        }
    }

    static func action(_ action: ProjectMailSignalsAction) -> any SharedSDK.ProjectMailSignalsAction {
        switch action {
        case .retry: SharedSDK.ProjectMailSignalsActionRetry.shared
        case .editInput(let field, let text):
            SharedSDK.ProjectMailSignalsActionEditInput(field: Self.field(field), text: text)
        case .add(let field): SharedSDK.ProjectMailSignalsActionAdd(field: Self.field(field))
        case .remove(let field, let value):
            SharedSDK.ProjectMailSignalsActionRemove(field: Self.field(field), value: value)
        case .save: SharedSDK.ProjectMailSignalsActionSave.shared
        case .assign: SharedSDK.ProjectMailSignalsActionAssign.shared
        case .retryPreview: SharedSDK.ProjectMailSignalsActionRetryPreview.shared
        case .dismissAssignment: SharedSDK.ProjectMailSignalsActionDismissAssignment.shared
        case .dismissFailure: SharedSDK.ProjectMailSignalsActionDismissFailure.shared
        }
    }
}
