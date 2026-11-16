import CoreKit
import Foundation

// MARK: - Field
extension InboxField {

    /// The label of the field: the server's, or the app's own for a field the app declares itself and for the
    /// recording parameters.
    var title: String {
        label.isEmpty ? Bundle.module.localizedString(forKey: "inbox.field.\(key)", value: key, table: nil) : label
    }

    /// The placeholder of a text field, or nil when the field has none.
    var hint: String? {
        guard let placeholder, !placeholder.isEmpty else { return nil }
        return placeholder
    }

    /// Identifier of the whole field.
    var identifier: String { InboxIdentifiers.fieldPrefix + key }
}

// MARK: - Choice
extension InboxChoice {

    /// The text of a choice: the server's, or the app's own for a static option of the field `fieldKey` (`start`,
    /// `http`, `auto`) and for the "none" choice.
    func title(in fieldKey: String) -> String {
        if !label.isEmpty { return label }
        if none { return Bundle.module.localizedString(forKey: "inbox.option.none", value: "", table: nil) }
        let key = "inbox.option.\(fieldKey).\(id ?? "")"
        return Bundle.module.localizedString(forKey: key, value: id ?? "", table: nil)
    }

    /// The first letters of a label, for the avatar of a person.
    var avatarInitials: String {
        if let initials, !initials.isEmpty { return initials }
        return String(label.split(separator: " ").prefix(2).compactMap(\.first)).uppercased()
    }
}
