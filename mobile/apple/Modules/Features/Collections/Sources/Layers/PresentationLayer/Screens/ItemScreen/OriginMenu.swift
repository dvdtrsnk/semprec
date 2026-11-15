import CoreKit
import DesignSystem
import SwiftUI

/// The mark of a value that is not the item's own: a blue chain for a value that follows another item, a struck
/// chain for one that no longer does, an arrow for one that is always computed. A tap opens the glass menu that says
/// where the value comes from and what can be done about it.
struct OriginBadge: View {

    // MARK: - Dependencies
    let field: FieldView
    let origin: ValueOrigin
    let sourceName: String
    let send: (ItemAction) -> Void
    let change: () -> Void

    // MARK: - State
    @State private var isOpen = false

    // MARK: - Body
    var body: some View {
        Button { isOpen = true } label: {
            Image(systemName: symbol)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(tint)
                .padding(6)
                .background(tint.opacity(0.14), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(accessibilityKey, bundle: .module))
        .accessibilityIdentifier(CollectionsIdentifiers.originPrefix + field.propertyKey)
        .popover(isPresented: $isOpen) {
            OriginMenu(
                field: field,
                origin: origin,
                sourceName: sourceName,
                send: send,
                change: change,
                close: { isOpen = false }
            )
                .presentationCompactAdaptation(.popover)
        }
    }
}

// MARK: - Subviews
private extension OriginBadge {

    var symbol: String {
        switch origin.kind {
        case .inherited: "link"
        case .inheritedBroken: "link.badge.plus"
        case .derived: "arrow.turn.down.right"
        }
    }

    var tint: Color {
        origin.kind == .inherited ? .blue : Theme.Colors.secondaryText
    }

    var accessibilityKey: LocalizedStringKey {
        switch origin.kind {
        case .inherited: "origin.accessibility.inherited"
        case .inheritedBroken: "origin.accessibility.broken"
        case .derived: "origin.accessibility.derived"
        }
    }
}

/// The small glass menu of a value that comes from another item: what it is, where it comes from, when the link
/// ends, and the actions to change it, end the link or take it over again.
struct OriginMenu: View {

    // MARK: - Dependencies
    let field: FieldView
    let origin: ValueOrigin
    let sourceName: String
    let send: (ItemAction) -> Void
    let change: () -> Void
    let close: () -> Void

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Text(title).font(.headline)
            Text(explanation).font(.subheadline).foregroundStyle(Theme.Colors.secondaryText)
            if origin.kind != .derived {
                Divider()
                actions
            }
        }
        .padding(Theme.Spacing.medium)
        .frame(minWidth: 260, idealWidth: 300, maxWidth: 340, alignment: .leading)
    }
}

// MARK: - Subviews
private extension OriginMenu {

    @ViewBuilder var actions: some View {
        if origin.kind == .inheritedBroken {
            action("origin.action.retake", symbol: "link") { send(.edit(.relink(propertyKey: field.propertyKey))) }
        }
        action("origin.action.change", symbol: "square.and.pencil") { change() }
        if origin.kind == .inherited {
            action("origin.action.unlink", symbol: "link.badge.plus") {
                send(.edit(.unlink(propertyKey: field.propertyKey)))
            }
        }
    }

    func action(_ key: LocalizedStringKey, symbol: String, perform: @escaping () -> Void) -> some View {
        Button {
            close()
            perform()
        } label: {
            Label { Text(key, bundle: .module) } icon: { Image(systemName: symbol) }
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .padding(.vertical, 4)
    }

    var title: String {
        switch origin.kind {
        case .inherited: String(format: String(localized: "origin.inherited.title", bundle: .module), field.name)
        case .inheritedBroken: String(format: String(localized: "origin.broken.title", bundle: .module), field.name)
        case .derived: String(format: String(localized: "origin.derived.title", bundle: .module), field.name)
        }
    }

    var explanation: String {
        switch origin.kind {
        case .inherited:
            String(format: String(localized: "origin.inherited.text", bundle: .module), sourceName)
        case .inheritedBroken:
            String(format: String(localized: brokenKey, bundle: .module), sourceName)
        case .derived:
            String(format: String(localized: "origin.derived.text", bundle: .module), sourceName)
        }
    }

    var brokenKey: String.LocalizationValue {
        origin.brokenBy == .agent ? "origin.broken.byAgent" : "origin.broken.byUser"
    }
}

// MARK: - Source name
extension FieldView {

    /// The source of the value by name, as the design principles word it ("task Send invoice"): the database of the
    /// source gives the noun. A derived value names the project the item gets it through, found among the item's
    /// own relations when the server did not name it.
    func sourceName(among fields: [FieldView]) -> String {
        let unknown = String(localized: "origin.source.unknown", bundle: .module)
        guard let source = origin?.sources.first else { return unknown }
        let title = source.title.isEmpty ? titleOfSource(source, among: fields) : source.title
        guard let title else { return unknown }
        let format = source.databaseKey.flatMap { Self.localized("origin.source.\($0)") }
            ?? String(localized: "origin.source.other", bundle: .module)
        return String(format: format, title)
    }

    /// The text of a key the catalog has, nil for a key it lacks (a database no noun is written for).
    private static func localized(_ key: String) -> String? {
        let text = Bundle.module.localizedString(forKey: key, value: nil, table: nil)
        return text == key ? nil : text
    }

    private func titleOfSource(_ source: OriginSource, among fields: [FieldView]) -> String? {
        for field in fields {
            guard case .targets(let targets) = field.content else { continue }
            if let match = targets.first(where: { $0.id == source.itemId }) { return match.title }
        }
        return nil
    }
}
