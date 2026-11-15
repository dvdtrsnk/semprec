import CoreKit
import DesignSystem
import SwiftUI

/// One property of an item: its name, its value drawn and edited by its kind, and, when the value comes from another
/// item, the mark that says so. A change is sent to the shared ViewModel as soon as it is made.
struct FieldRowView: View {

    // MARK: - Dependencies
    let field: FieldView
    let fields: [FieldView]
    let format: FieldFormat
    let send: (ItemAction) -> Void

    // MARK: - State
    @State private var draft = ""

    // MARK: - Body
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.medium) {
            Text(field.name).foregroundStyle(Theme.Colors.secondaryText).frame(minWidth: 84, alignment: .leading)
            Spacer(minLength: 0)
            value.frame(maxWidth: .infinity, alignment: .trailing)
            if let origin = field.origin {
                OriginBadge(
                    field: field,
                    origin: origin,
                    sourceName: field.sourceName(among: fields),
                    send: send,
                    change: { send(.picker(.open(propertyKey: field.propertyKey))) }
                )
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CollectionsIdentifiers.fieldPrefix + field.propertyKey)
        .onAppear { draft = FieldRowView.draft(of: field.content, format: format) }
        .onChange(of: field.content) { _, content in draft = FieldRowView.draft(of: content, format: format) }
    }
}

// MARK: - Value
private extension FieldRowView {

    @ViewBuilder var value: some View {
        if field.editable {
            editor
        } else {
            readOnly
        }
    }

    @ViewBuilder var editor: some View {
        switch field.kind {
        case .text, .url: textField
        case .longText: textField.lineLimit(1...6)
        case .number: textField.multilineTextAlignment(.trailing)
        case .select, .multiSelect: choiceMenu
        case .date: dateEditor
        case .time: timeEditor
        case .checkbox: toggle
        case .relation: RelationValueView(field: field, send: send)
        case .file: readOnly
        }
    }

    var readOnly: some View {
        Group {
            switch field.content {
            case .targets(let targets):
                TargetChips(targets: targets) {
                    send(.navigate(.openTarget(id: $0.id, databaseKey: $0.databaseKey)))
                }
            case .blob: FileValueView(field: field, format: format, send: send)
            case .choices(let options): choicePills(options)
            default: Text(format.text(for: field.content) ?? "").multilineTextAlignment(.trailing)
            }
        }
    }
}

// MARK: - Editors
private extension FieldRowView {

    var textField: some View {
        TextField(text: $draft, axis: field.kind == .longText ? .vertical : .horizontal) {
            Text("field.empty", bundle: .module)
        }
        .multilineTextAlignment(.trailing)
        .textInput(field.kind == .url ? .url : .plain)
        .onSubmit(commitText)
    }

    func commitText() {
        if field.kind == .number {
            let number = Double(draft.replacingOccurrences(of: ",", with: "."))
            send(.edit(.setNumber(propertyKey: field.propertyKey, number: number)))
        } else {
            send(.edit(.setText(propertyKey: field.propertyKey, text: draft)))
        }
    }

    var choiceMenu: some View {
        Menu {
            if field.kind == .select {
                Button { send(.edit(.setChoices(propertyKey: field.propertyKey, keys: []))) } label: {
                    Text("field.none", bundle: .module)
                }
            }
            ForEach(field.options, id: \.key) { option in
                Button { choose(option) } label: {
                    if selectedKeys.contains(option.key) {
                        Label(option.label, systemImage: "checkmark")
                    } else {
                        Text(option.label)
                    }
                }
            }
        } label: {
            if case .choices(let options) = field.content, !options.isEmpty {
                choicePills(options)
            } else {
                Text("field.empty", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }

    var selectedKeys: Set<String> {
        if case .choices(let options) = field.content { Set(options.map(\.key)) } else { [] }
    }

    func choose(_ option: FieldOption) {
        var keys = selectedKeys
        if field.kind == .multiSelect {
            if keys.contains(option.key) { keys.remove(option.key) } else { keys.insert(option.key) }
            let ordered = field.options.map(\.key).filter(keys.contains)
            send(.edit(.setChoices(propertyKey: field.propertyKey, keys: ordered)))
        } else {
            send(.edit(.setChoices(propertyKey: field.propertyKey, keys: [option.key])))
        }
    }

    func choicePills(_ options: [FieldOption]) -> some View {
        HStack(spacing: 4) {
            ForEach(options, id: \.key) { StatusPill(option: $0) }
        }
    }

    @ViewBuilder var dateEditor: some View {
        if case .day(let iso) = field.content, let date = format.date(fromISO: iso) {
            HStack {
                DatePicker(selection: dateBinding(date), displayedComponents: .date) { EmptyView() }.labelsHidden()
                clearButton
            }
        } else {
            Button { send(.edit(.setText(propertyKey: field.propertyKey, text: format.iso(from: Date())))) } label: {
                Text("field.addDate", bundle: .module)
            }
        }
    }

    func dateBinding(_ current: Date) -> Binding<Date> {
        Binding(
            get: { current },
            set: { send(.edit(.setText(propertyKey: field.propertyKey, text: format.iso(from: $0)))) }
        )
    }

    @ViewBuilder var timeEditor: some View {
        if case .clock(let time) = field.content {
            HStack {
                Text(format.time(time))
                clearButton
            }
        } else {
            Text("field.empty", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    var clearButton: some View {
        Button { send(.edit(.setText(propertyKey: field.propertyKey, text: ""))) } label: {
            Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.Colors.secondaryText)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("field.clear", bundle: .module))
    }

    var toggle: some View {
        Toggle(isOn: Binding(
            get: { if case .flag(let isOn) = field.content { isOn } else { false } },
            set: { send(.edit(.setFlag(propertyKey: field.propertyKey, isOn: $0))) }
        )) { EmptyView() }
        .labelsHidden()
    }

    /// The text a field starts editing from.
    static func draft(of content: FieldContent, format: FieldFormat) -> String {
        switch content {
        case .text(let text), .link(let text): text
        case .number(let number): number.formatted(.number.grouping(.never))
        default: ""
        }
    }
}
