@preconcurrency internal import SharedSDK

/// The Kotlin `ItemViewModel` as an `ItemScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedItemScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.ItemViewModel
    private let effectQueue: EffectQueue<ItemEffect>
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.ItemViewModel) {
        self.viewModel = viewModel
        effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedItemScreenModel: ScreenModel {

    var state: ItemState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<ItemState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    func effects() -> AsyncStream<ItemEffect> {
        effectQueue.stream()
    }

    func send(_ action: ItemAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedItemScreenModel {

    static func state(_ state: SharedSDK.ItemState) -> ItemState {
        ItemState(
            phase: phase(state.phase),
            failure: state.failure.map(FailureKind.init),
            header: state.header.map(header),
            fields: state.fields.map(FieldView.init),
            related: state.related.map(related),
            page: page(state.page),
            preview: state.preview.map(preview),
            picker: state.picker.map(picker),
            deletion: state.deletion.map(deletion),
            saving: state.saving,
            writeFailure: state.writeFailure.map(writeFailure),
            choiceFailure: state.choiceFailure.map(writeFailure),
            deleted: state.deleted
        )
    }

    static func writeFailure(_ failure: SharedSDK.ItemWriteFailure) -> ItemWriteFailure {
        ItemWriteFailure(propertyKey: failure.propertyKey, kind: failure.kind.map(FailureKind.init))
    }

    static func action(_ action: ItemAction) -> any SharedSDK.ItemAction {
        switch action {
        case .retry: SharedSDK.ItemActionRetry.shared
        case .refresh: SharedSDK.ItemActionRefresh.shared
        case .dismissWriteFailure: SharedSDK.ItemActionDismissWriteFailure.shared
        case .edit(let edit): editAction(edit)
        case .picker(let picker): pickerAction(picker)
        case .page(let page): pageAction(page)
        case .preview(let preview): previewAction(preview)
        case .deletion(let deletion): deletionAction(deletion)
        case .navigate(let navigate): navigateAction(navigate)
        }
    }

    static func effect(_ effect: any SharedSDK.ItemEffect) -> ItemEffect {
        switch onEnum(of: effect) {
        case .openItem(let open): .openItem(itemId: open.itemId, databaseKey: open.databaseKey)
        case .openCollection(let open):
            .openCollection(databaseId: open.databaseId, databaseKey: open.databaseKey, filterJson: open.filterJson)
        case .close: .close
        }
    }
}

// MARK: - Mapping of the actions
extension SharedItemScreenModel {

    static func editAction(_ action: ItemAction.Edit) -> any SharedSDK.ItemAction {
        switch action {
        case .rename(let title): SharedSDK.ItemActionEditRename(title: title)
        case .setText(let key, let text): SharedSDK.ItemActionEditSetText(propertyKey: key, text: text)
        case .setNumber(let key, let number):
            SharedSDK.ItemActionEditSetNumber(propertyKey: key, number: number.map { KotlinDouble(double: $0) })
        case .setFlag(let key, let isOn): SharedSDK.ItemActionEditSetFlag(propertyKey: key, on: isOn)
        case .setChoices(let key, let keys): SharedSDK.ItemActionEditSetChoices(propertyKey: key, keys: keys)
        case .addChoice(let key, let label): SharedSDK.ItemActionEditAddChoice(propertyKey: key, label: label)
        case .unlink(let key): SharedSDK.ItemActionEditUnlink(propertyKey: key)
        case .relink(let key): SharedSDK.ItemActionEditRelink(propertyKey: key)
        case .removeTarget(let key, let targetId):
            SharedSDK.ItemActionEditRemoveTarget(propertyKey: key, targetId: targetId)
        }
    }

    static func pickerAction(_ action: ItemAction.Picker) -> any SharedSDK.ItemAction {
        switch action {
        case .open(let key): SharedSDK.ItemActionPickerOpen(propertyKey: key)
        case .search(let text): SharedSDK.ItemActionPickerSearch(text: text)
        case .choose(let targetId): SharedSDK.ItemActionPickerChoose(targetId: targetId)
        case .close: SharedSDK.ItemActionPickerClose.shared
        }
    }

    static func pageAction(_ action: ItemAction.Page) -> any SharedSDK.ItemAction {
        switch action {
        case .save(let markdown): SharedSDK.ItemActionPageSave(markdown: markdown)
        case .reload: SharedSDK.ItemActionPageReload.shared
        }
    }

    static func previewAction(_ action: ItemAction.Preview) -> any SharedSDK.ItemAction {
        switch action {
        case .load(let key): SharedSDK.ItemActionPreviewLoad(propertyKey: key)
        case .close: SharedSDK.ItemActionPreviewClose.shared
        }
    }

    static func deletionAction(_ action: ItemAction.Deletion) -> any SharedSDK.ItemAction {
        switch action {
        case .request: SharedSDK.ItemActionDeletionRequest.shared
        case .cancel: SharedSDK.ItemActionDeletionCancel.shared
        case .confirm: SharedSDK.ItemActionDeletionConfirm.shared
        }
    }

    static func navigateAction(_ action: ItemAction.Navigate) -> any SharedSDK.ItemAction {
        switch action {
        case .openRelated(let databaseId): SharedSDK.ItemActionNavigateOpenRelated(databaseId: databaseId)
        case .openTarget(let id, let key): SharedSDK.ItemActionNavigateOpenTarget(id: id, databaseKey: key)
        }
    }
}

// MARK: - Mapping of the parts
extension SharedItemScreenModel {

    static func phase(_ phase: SharedSDK.ItemPhase) -> ItemPhase {
        switch phase {
        case .loading: .loading
        case .content: .content
        case .error: .error
        }
    }

    static func header(_ header: SharedSDK.ItemHeader) -> ItemHeader {
        ItemHeader(
            itemId: header.itemId,
            databaseId: header.databaseId,
            databaseKey: header.databaseKey,
            databaseName: header.databaseName,
            icon: header.icon,
            color: header.color,
            title: header.title
        )
    }

    static func related(_ related: SharedSDK.RelatedView) -> RelatedView {
        RelatedView(
            databaseId: related.databaseId,
            databaseKey: related.databaseKey,
            name: related.name,
            icon: related.icon,
            color: related.color,
            count: Int(related.count)
        )
    }

    static func page(_ page: SharedSDK.PageView) -> PageView {
        let status: PageStatus
        switch page.status {
        case .loading: status = .loading
        case .ready: status = .ready
        case .saving: status = .saving
        case .conflict: status = .conflict
        case .error: status = .error
        }
        return PageView(status: status, markdown: page.markdown, failure: page.failure.map(FailureKind.init))
    }

    static func preview(_ preview: SharedSDK.PreviewView) -> PreviewView {
        let status: PreviewStatus
        switch preview.status {
        case .loading: status = .loading
        case .ready: status = .ready
        case .error: status = .error
        }
        return PreviewView(
            blobId: preview.blobId,
            filename: preview.filename,
            mimeType: preview.mimeType,
            status: status,
            base64: preview.base64,
            failure: preview.failure.map(FailureKind.init)
        )
    }

    static func picker(_ picker: SharedSDK.PickerView) -> PickerView {
        PickerView(
            propertyKey: picker.propertyKey,
            name: picker.name,
            loading: picker.loading,
            failure: picker.failure.map(Failed.init),
            candidates: picker.candidates.map(FieldTarget.init)
        )
    }

    static func deletion(_ deletion: SharedSDK.DeletionView) -> DeletionView {
        DeletionView(
            loading: deletion.loading,
            failure: deletion.failure.map(Failed.init),
            impact: deletion.impact.map { impact in
                ImpactView(
                    related: impact.related.map { ImpactEntry(databaseKey: $0.databaseKey, count: Int($0.count)) },
                    nestedItems: Int(impact.nestedItems),
                    nestedPages: Int(impact.nestedPages),
                    takenOverValues: Int(impact.takenOverValues),
                    seriesInstances: Int(impact.seriesInstances),
                    attachments: Int(impact.attachments),
                    hostEvents: Int(impact.hostEvents)
                )
            },
            deleting: deletion.deleting
        )
    }
}
