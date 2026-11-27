import Foundation

public enum ItemPhase: Equatable, Sendable {

    case loading, content, error
}

/// The item and the collection it belongs to; names and colors are in the language of the signed-in person.
public struct ItemHeader: Equatable, Sendable {

    public let itemId: String
    public let databaseId: String
    public let databaseKey: String?
    public let databaseName: String
    public let icon: String?
    public let color: String?
    public let title: String

    public init(
        itemId: String,
        databaseId: String,
        databaseKey: String?,
        databaseName: String,
        icon: String?,
        color: String?,
        title: String
    ) {
        self.itemId = itemId
        self.databaseId = databaseId
        self.databaseKey = databaseKey
        self.databaseName = databaseName
        self.icon = icon
        self.color = color
        self.title = title
    }
}

/// A collection connected to the item: `count` items of one database, openable as a collection.
public struct RelatedView: Equatable, Sendable, Identifiable {

    public let databaseId: String
    public let databaseKey: String?
    public let name: String
    public let icon: String?
    public let color: String?
    public let count: Int

    public var id: String { databaseId }

    public init(databaseId: String, databaseKey: String?, name: String, icon: String?, color: String?, count: Int) {
        self.databaseId = databaseId
        self.databaseKey = databaseKey
        self.name = name
        self.icon = icon
        self.color = color
        self.count = count
    }
}

public enum PageStatus: Equatable, Sendable {

    case loading, ready, saving, conflict, error
}

/// The item's own document as Markdown; `failure` explains `.error` (nil there is unexpected).
public struct PageView: Equatable, Sendable {

    public let status: PageStatus
    public let markdown: String
    public let failure: FailureKind?

    public init(status: PageStatus, markdown: String, failure: FailureKind?) {
        self.status = status
        self.markdown = markdown
        self.failure = failure
    }
}

public enum PreviewStatus: Equatable, Sendable {

    case loading, ready, error
}

/// A downloaded file shown in full; `base64` holds its bytes once the status is `.ready`.
public struct PreviewView: Equatable, Sendable {

    public let blobId: String
    public let filename: String?
    public let mimeType: String
    public let status: PreviewStatus
    public let base64: String?
    public let failure: FailureKind?

    public init(
        blobId: String,
        filename: String?,
        mimeType: String,
        status: PreviewStatus,
        base64: String?,
        failure: FailureKind?
    ) {
        self.blobId = blobId
        self.filename = filename
        self.mimeType = mimeType
        self.status = status
        self.base64 = base64
        self.failure = failure
    }
}

/// Items a relation can be pointed at, found by a search of the target database.
public struct PickerView: Equatable, Sendable {

    public let propertyKey: String
    public let name: String
    public let loading: Bool
    public let failure: Failed?
    public let candidates: [FieldTarget]

    public init(propertyKey: String, name: String, loading: Bool, failure: Failed?, candidates: [FieldTarget]) {
        self.propertyKey = propertyKey
        self.name = name
        self.loading = loading
        self.failure = failure
        self.candidates = candidates
    }
}

public struct ImpactEntry: Equatable, Sendable {

    public let databaseKey: String?
    public let count: Int

    public init(databaseKey: String?, count: Int) {
        self.databaseKey = databaseKey
        self.count = count
    }
}

/// What deleting the item reaches, to be stated before it is confirmed.
public struct ImpactView: Equatable, Sendable {

    public let related: [ImpactEntry]
    public let nestedItems: Int
    public let nestedPages: Int
    public let takenOverValues: Int
    public let seriesInstances: Int
    public let attachments: Int
    public let hostEvents: Int

    public init(
        related: [ImpactEntry],
        nestedItems: Int,
        nestedPages: Int,
        takenOverValues: Int,
        seriesInstances: Int,
        attachments: Int,
        hostEvents: Int
    ) {
        self.related = related
        self.nestedItems = nestedItems
        self.nestedPages = nestedPages
        self.takenOverValues = takenOverValues
        self.seriesInstances = seriesInstances
        self.attachments = attachments
        self.hostEvents = hostEvents
    }
}

/// The delete confirmation: it first reads the impact, then waits for the person.
public struct DeletionView: Equatable, Sendable {

    public let loading: Bool
    public let failure: Failed?
    public let impact: ImpactView?
    public let deleting: Bool

    public init(loading: Bool, failure: Failed?, impact: ImpactView?, deleting: Bool) {
        self.loading = loading
        self.failure = failure
        self.impact = impact
        self.deleting = deleting
    }
}

/// A write that did not go through; `kind` is nil for an unexpected failure.
public struct ItemWriteFailure: Equatable, Sendable {

    public let propertyKey: String?
    public let kind: FailureKind?

    public init(propertyKey: String?, kind: FailureKind?) {
        self.propertyKey = propertyKey
        self.kind = kind
    }
}

/// Everything one item detail shows.
public struct ItemState: Equatable, Sendable {

    public var phase: ItemPhase
    /// The expected failure behind `.error`; nil for an unexpected one.
    public var failure: FailureKind?
    public var header: ItemHeader?
    public var fields: [FieldView]
    public var related: [RelatedView]
    public var page: PageView
    public var preview: PreviewView?
    public var picker: PickerView?
    public var deletion: DeletionView?
    public var saving: Bool
    /// The last write that failed; the item screen shows it as an alert.
    public var writeFailure: ItemWriteFailure?
    /// The last new choice (`.edit(.addChoice)`) that could not be added and set, shown only where choices are added.
    public var choiceFailure: ItemWriteFailure?
    public var deleted: Bool

    public init(
        phase: ItemPhase = .loading,
        failure: FailureKind? = nil,
        header: ItemHeader? = nil,
        fields: [FieldView] = [],
        related: [RelatedView] = [],
        page: PageView = PageView(status: .loading, markdown: "", failure: nil),
        preview: PreviewView? = nil,
        picker: PickerView? = nil,
        deletion: DeletionView? = nil,
        saving: Bool = false,
        writeFailure: ItemWriteFailure? = nil,
        choiceFailure: ItemWriteFailure? = nil,
        deleted: Bool = false
    ) {
        self.phase = phase
        self.failure = failure
        self.header = header
        self.fields = fields
        self.related = related
        self.page = page
        self.preview = preview
        self.picker = picker
        self.deletion = deletion
        self.saving = saving
        self.writeFailure = writeFailure
        self.choiceFailure = choiceFailure
        self.deleted = deleted
    }
}

public enum ItemAction: Equatable, Sendable {

    case retry
    /// Reads the item again over what is on screen, for when the screen appears again.
    case refresh
    case dismissWriteFailure
    case edit(Edit)
    case picker(Picker)
    case page(Page)
    case preview(Preview)
    case deletion(Deletion)
    case navigate(Navigate)

    /// Writes to the item's properties and values.
    public enum Edit: Equatable, Sendable {

        case rename(String)
        case setText(propertyKey: String, text: String)
        case setNumber(propertyKey: String, number: Double?)
        case setFlag(propertyKey: String, isOn: Bool)
        case setChoices(propertyKey: String, keys: [String])
        /// Adds a new choice named `label` to a select or multi-select and sets it on the item, a multi-select keeping
        /// the choices it holds; a blank name changes nothing.
        case addChoice(propertyKey: String, label: String)
        /// Ends the link that makes a value follow its source; the value stays as the item's own.
        case unlink(propertyKey: String)
        /// Makes the value follow its source again.
        case relink(propertyKey: String)
        case removeTarget(propertyKey: String, targetId: String)
    }

    /// Points a relation at another item.
    public enum Picker: Equatable, Sendable {

        case open(propertyKey: String)
        case search(String)
        case choose(targetId: String)
        case close
    }

    public enum Page: Equatable, Sendable {

        case save(String)
        case reload
    }

    public enum Preview: Equatable, Sendable {

        case load(propertyKey: String)
        case close
    }

    public enum Deletion: Equatable, Sendable {

        case request
        case cancel
        case confirm
    }

    public enum Navigate: Equatable, Sendable {

        case openRelated(databaseId: String)
        case openTarget(id: String, databaseKey: String?)
    }
}

public enum ItemEffect: Equatable, Sendable {

    case openItem(itemId: String, databaseKey: String?)
    /// Open the collection of the items a related collection holds; `filterJson` is passed back to the collection.
    case openCollection(databaseId: String, databaseKey: String?, filterJson: String?)
    /// The item was deleted; its screen is to be closed.
    case close
}

public typealias ItemScreenModel = ScreenModel<ItemState, ItemAction, ItemEffect>

/// Item screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedItemScreenModel = ScriptedScreenModel<ItemState, ItemAction, ItemEffect>
