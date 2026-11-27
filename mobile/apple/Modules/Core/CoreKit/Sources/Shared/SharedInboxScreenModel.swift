@preconcurrency internal import SharedSDK

/// The Kotlin `InboxViewModel` as an `InboxScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedInboxScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.InboxViewModel
    private let effectQueue: EffectQueue<InboxEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.InboxViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedInboxScreenModel: ScreenModel {

    var state: InboxState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<InboxState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<InboxEffect> {
        effectQueue.stream()
    }

    func send(_ action: InboxAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedInboxScreenModel {

    static func state(_ state: SharedSDK.InboxState) -> InboxState {
        switch state.phase {
        case .loading: .loading
        case .content: .content(content(state))
        case .error: .failure(state.failure.map(FailureKind.init))
        }
    }

    private static func content(_ state: SharedSDK.InboxState) -> InboxContent {
        InboxContent(
            cards: state.cards.map(card),
            handled: Int(state.handled),
            dropped: Int(state.dropped),
            canUndo: state.canUndo,
            refreshing: state.refreshing,
            busy: state.busy,
            result: state.result.map { InboxResult(label: $0.label, databaseKey: $0.databaseKey, itemId: $0.itemId) },
            problem: state.problem.map(problem),
            problemFailure: state.problemFailure.map(FailureKind.init),
            picker: state.picker.map(picker)
        )
    }

    static func effect(_ effect: any SharedSDK.InboxEffect) -> InboxEffect {
        switch onEnum(of: effect) {
        case .openItem(let item): .openItem(databaseKey: item.databaseKey, itemId: item.itemId)
        }
    }

    static func action(_ action: InboxAction) -> any SharedSDK.InboxAction {
        switch action {
        case .retry: SharedSDK.InboxActionRetry.shared
        case .refresh: SharedSDK.InboxActionRefresh.shared
        case .approve: SharedSDK.InboxActionApprove.shared
        case .reject: SharedSDK.InboxActionReject.shared
        case .undo: SharedSDK.InboxActionUndo.shared
        case .openResult: SharedSDK.InboxActionOpenResult.shared
        case .dismissResult: SharedSDK.InboxActionDismissResult.shared
        case .dismissProblem: SharedSDK.InboxActionDismissProblem.shared
        case .reset(let cardId): SharedSDK.InboxActionReset(cardId: cardId)
        case .recompute(let cardId): SharedSDK.InboxActionRecompute(cardId: cardId)
        case .closePicker, .openPicker, .setSecret: pickerAction(action)
        case .setText, .setFlag, .setDate, .setTime, .pick, .toggle: fieldAction(action)
        }
    }

    private static func pickerAction(_ action: InboxAction) -> any SharedSDK.InboxAction {
        switch action {
        case .openPicker(let cardId, let key): SharedSDK.InboxActionOpenPicker(cardId: cardId, key: key)
        case .setSecret(let cardId, let text): SharedSDK.InboxActionSetSecret(cardId: cardId, text: text)
        default: SharedSDK.InboxActionClosePicker.shared
        }
    }

    private static func fieldAction(_ action: InboxAction) -> any SharedSDK.InboxAction {
        switch action {
        case .setText(let cardId, let key, let text):
            SharedSDK.InboxActionSetText(cardId: cardId, key: key, text: text)
        case .setFlag(let cardId, let key, let value):
            SharedSDK.InboxActionSetFlag(cardId: cardId, key: key, on: value)
        case .setDate(let cardId, let key, let date):
            SharedSDK.InboxActionSetDate(cardId: cardId, key: key, date: date)
        case .setTime(let cardId, let key, let time):
            SharedSDK.InboxActionSetTime(cardId: cardId, key: key, time: time)
        case .toggle(let cardId, let key, let choiceId):
            SharedSDK.InboxActionToggle(cardId: cardId, key: key, choiceId: choiceId)
        case .pick(let cardId, let key, let choiceId):
            SharedSDK.InboxActionPick(cardId: cardId, key: key, choiceId: choiceId)
        default: SharedSDK.InboxActionClosePicker.shared
        }
    }
}

// MARK: - Cards
extension SharedInboxScreenModel {

    static func card(_ card: SharedSDK.InboxCardState) -> InboxCard {
        InboxCard(
            id: card.id,
            type: type(card.type),
            baseType: type(card.baseType),
            phase: phase(card.phase),
            approvable: approvable(card.approvable),
            origin: card.origin.map(origin),
            targets: card.targets,
            invalidText: card.invalidText,
            invalidField: card.invalidField,
            approval: card.approval.map {
                InboxApproval(risk: risk($0.risk), operation: $0.operation, reason: $0.reason)
            },
            groups: card.groups.map { group in
                InboxGroup(key: group.key, fields: group.fields.map(field))
            },
            quotes: card.quotes,
            reason: card.reason,
            edited: card.edited,
            saving: card.saving
        )
    }

    static func field(_ field: SharedSDK.InboxFieldState) -> InboxField {
        InboxField(
            key: field.key,
            type: fieldType(field.type),
            keyboard: keyboard(field.keyboard),
            label: field.label,
            placeholder: field.placeholder,
            required: field.required,
            missing: field.missing,
            edited: field.edited,
            text: field.text,
            flag: field.flag,
            date: field.date,
            time: field.time,
            showTime: field.showTime,
            selected: field.selected.map(choice),
            options: field.options.map(choice),
            needsPicker: field.needsPicker,
            info: field.info
        )
    }

    static func choice(_ choice: SharedSDK.InboxChoiceItem) -> InboxChoice {
        InboxChoice(
            id: choice.id,
            label: choice.label,
            color: choice.color,
            initials: choice.initials,
            hint: choice.hint,
            date: choice.date,
            timeFrom: choice.timeFrom,
            timeTo: choice.timeTo,
            selected: choice.selected,
            disabled: choice.disabled,
            suggested: choice.suggested,
            none: choice.none,
            isNew: choice.isNew
        )
    }

    static func picker(_ picker: SharedSDK.InboxPickerState) -> InboxPicker {
        let phase: InboxPickerPhase = switch picker.phase {
        case .loading: .loading
        case .ready: .ready
        case .error: .error
        }
        return InboxPicker(
            cardId: picker.cardId,
            key: picker.key,
            multi: picker.multi,
            phase: phase,
            options: picker.options.map(choice)
        )
    }

    static func origin(_ origin: SharedSDK.InboxOriginState) -> InboxOrigin {
        let kind: InboxOriginKind = switch origin.kind {
        case .capture: .capture
        case .transcript: .transcript
        case .run: .run
        }
        return InboxOrigin(
            kind: kind,
            text: origin.text,
            date: origin.date,
            time: origin.time,
            typeLabel: origin.typeLabel,
            typeEmoji: origin.typeEmoji,
            name: origin.name,
            sourceKind: origin.sourceKind,
            threadTitle: origin.threadTitle,
            heartbeatName: origin.heartbeatName,
            mcpClientName: origin.mcpClientName
        )
    }
}

// MARK: - Enums
extension SharedInboxScreenModel {

    /// The kinds have the same names on both sides; an unknown one can only be discarded.
    private static let types: [SharedSDK.InboxCardType: InboxCardType] = [
        .task: .task, .event: .event, .page: .page, .journal: .journal, .project: .project,
        .company: .company, .person: .person, .health: .health, .file: .file, .recording: .recording, .mcp: .mcp,
        .invalid: .invalid, .clarify: .clarify, .transcriptEvent: .transcriptEvent, .speaker: .speaker,
        .approval: .approval, .unsupported: .unsupported
    ]

    static func type(_ type: SharedSDK.InboxCardType) -> InboxCardType {
        types[type] ?? .unsupported
    }

    static func phase(_ phase: SharedSDK.InboxCardPhase) -> InboxCardPhase {
        switch phase {
        case .proposed: .proposed
        case .computing: .computing
        case .computeFailed: .computeFailed
        case .needsClarification: .needsClarification
        case .invalid: .invalid
        case .pending: .pending
        }
    }

    static func approvable(_ approvable: SharedSDK.InboxApprovable) -> InboxApprovable {
        switch approvable {
        case .ready: .ready
        case .missingFields: .missingFields
        case .computing: .computing
        case .computeFailed: .computeFailed
        case .invalid: .invalid
        case .unsupported: .unsupported
        }
    }

    static func fieldType(_ type: SharedSDK.InboxFieldType) -> InboxFieldType {
        switch type {
        case .text: .text
        case .area: .area
        case .date: .date
        case .datetime: .datetime
        case .select: .select
        case .multi: .multi
        case .toggle: .toggle
        case .seg: .seg
        case .color: .color
        case .secret: .secret
        case .info: .info
        case .choice: .choice
        case .tile: .tile
        }
    }

    static func keyboard(_ keyboard: SharedSDK.InboxKeyboard) -> InboxKeyboard {
        switch keyboard {
        case .text: .text
        case .email: .email
        case .url: .url
        case .tel: .tel
        }
    }

    static func risk(_ risk: SharedSDK.InboxRiskLevel) -> InboxRiskLevel {
        switch risk {
        case .irreversible: .irreversible
        case .outbound: .outbound
        case .breaksLink: .breaksLink
        case .write: .write
        }
    }

    static func problem(_ problem: SharedSDK.InboxProblem) -> InboxProblem {
        switch problem {
        case .edit: .edit
        case .decision: .decision
        case .undo: .undo
        case .recompute: .recompute
        }
    }
}
