import Foundation

/// How a property of an item is drawn and edited.
public enum FieldKind: Equatable, Sendable {

    case text, longText, number, select, multiSelect, date, time, checkbox, relation, file, url
}

/// A choice of a select property; the label is in the language of the signed-in person.
public struct FieldOption: Equatable, Sendable, Hashable {

    public let key: String
    public let label: String
    public let color: String?

    public init(key: String, label: String, color: String?) {
        self.key = key
        self.label = label
        self.color = color
    }
}

/// An item another item points at. `databaseKey` is nil for a database a person created.
public struct FieldTarget: Equatable, Sendable, Hashable {

    public let id: String
    public let databaseKey: String?
    public let title: String
    public let color: String?

    public init(id: String, databaseKey: String?, title: String, color: String?) {
        self.id = id
        self.databaseKey = databaseKey
        self.title = title
        self.color = color
    }
}

/// What a property holds, ready to draw.
public enum FieldContent: Equatable, Sendable {

    case empty
    case text(String)
    case number(Double)
    case flag(Bool)
    /// A calendar day or a date with a time, as the server stores it.
    case day(String)
    /// A time of day, `HH:mm`.
    case clock(String)
    case link(String)
    case choices([FieldOption])
    case targets([FieldTarget])
    case blob(blobId: String, filename: String?, mimeType: String, byteSize: Int64)
}

/// Where a value that is not the item's own comes from.
public enum OriginKind: Equatable, Sendable {

    /// Follows its source until the first change.
    case inherited
    /// Was inherited and no longer follows its source.
    case inheritedBroken
    /// Always computed from another item.
    case derived
}

public enum OriginAuthor: Equatable, Sendable {

    case user
    case agent
}

/// The item a value is taken from; `title` is empty when the server did not name it.
public struct OriginSource: Equatable, Sendable, Hashable {

    public let itemId: String?
    public let databaseKey: String?
    public let title: String

    public init(itemId: String?, databaseKey: String?, title: String) {
        self.itemId = itemId
        self.databaseKey = databaseKey
        self.title = title
    }
}

public struct ValueOrigin: Equatable, Sendable {

    public let kind: OriginKind
    public let sources: [OriginSource]
    public let brokenBy: OriginAuthor?

    public init(kind: OriginKind, sources: [OriginSource], brokenBy: OriginAuthor?) {
        self.kind = kind
        self.sources = sources
        self.brokenBy = brokenBy
    }
}

/// One property of an item with its value, its choices and where the value comes from.
public struct FieldView: Equatable, Sendable, Identifiable {

    public let propertyKey: String
    public let name: String
    public let kind: FieldKind
    public let content: FieldContent
    public let options: [FieldOption]
    public let editable: Bool
    public let origin: ValueOrigin?

    public var id: String { propertyKey }

    public init(
        propertyKey: String,
        name: String,
        kind: FieldKind,
        content: FieldContent,
        options: [FieldOption],
        editable: Bool,
        origin: ValueOrigin?
    ) {
        self.propertyKey = propertyKey
        self.name = name
        self.kind = kind
        self.content = content
        self.options = options
        self.editable = editable
        self.origin = origin
    }
}
