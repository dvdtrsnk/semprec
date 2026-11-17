import CoreKit
import DesignSystem
import SwiftUI

/// The layout of a book or a film: its cover with the title and what Semp found about it, its status as a segmented
/// picker, the person's stars, who they watched a film with, and notes. The rest of the properties stay editable
/// under Details.
struct MediaItemContent: View {

    // MARK: - Dependencies
    let state: ItemState
    let header: ItemHeader
    let send: (ItemAction) -> Void

    // MARK: - State
    @State private var titleDraft = ""

    // MARK: - Body
    var body: some View {
        List {
            Section { cover.listRowBackground(Color.clear) }
            if let status = field(MediaKeys.status) {
                Section { statusPicker(status) }
            }
            if let rating = field(MediaKeys.rating) {
                Section { ratingRow(rating) }
            }
            if let watched = field(MediaKeys.watchedWith) {
                Section {
                    RelationValueView(field: watched, send: send)
                } header: {
                    Text("item.media.watchedWith", bundle: .module)
                } footer: {
                    Text("item.media.watchedWith.hint", bundle: .module)
                }
            }
            Section(header: Text("item.media.notes", bundle: .module)) { notes }
            if !details.isEmpty {
                Section(header: Text("item.media.details", bundle: .module)) {
                    ForEach(details) { field in
                        FieldRowView(field: field, fields: state.fields, format: FieldFormat(), send: send)
                    }
                }
            }
            Section {
                Button(role: .destructive) { send(.deletion(.request)) } label: { Text("item.delete", bundle: .module) }
                    .accessibilityIdentifier(CollectionsIdentifiers.deleteButton)
            }
        }
        .onAppear { titleDraft = header.title }
        .onChange(of: header.title) { _, title in titleDraft = title }
    }
}

// MARK: - Subviews
private extension MediaItemContent {

    var cover: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.medium) {
            MediaCover(title: header.title, subtitle: metaParts.first, width: 96)
            VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                TextField(text: $titleDraft, axis: .vertical) { Text("item.title.placeholder", bundle: .module) }
                    .font(.title2.weight(.semibold))
                    .onSubmit { send(.edit(.rename(titleDraft))) }
                    .accessibilityIdentifier(CollectionsIdentifiers.itemTitle)
                if let meta {
                    Text(meta).font(.subheadline).foregroundStyle(Theme.Colors.secondaryText)
                }
                if let source = sourceRating {
                    Text(source).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
        }
        .padding(.vertical, Theme.Spacing.small)
    }

    func statusPicker(_ status: FieldView) -> some View {
        Picker(selection: Binding(get: { selectedKey(of: status) }, set: { key in
            send(.edit(.setChoices(propertyKey: status.propertyKey, keys: [key])))
        })) {
            ForEach(status.options, id: \.key) { option in
                Text(option.label).tag(option.key)
            }
        } label: {
            Text(status.name)
        }
        .pickerStyle(.segmented)
        .disabled(!status.editable)
        .accessibilityIdentifier(CollectionsIdentifiers.mediaStatus)
    }

    func ratingRow(_ rating: FieldView) -> some View {
        LabeledContent {
            StarPicker(rating: stars(of: rating)) { value in
                send(.edit(.setNumber(propertyKey: rating.propertyKey, number: value.map(Double.init))))
            }
            .disabled(!rating.editable)
        } label: {
            Text("item.media.rating", bundle: .module)
        }
        .accessibilityIdentifier(CollectionsIdentifiers.mediaRating)
    }

    @ViewBuilder var notes: some View {
        if let field = field(MediaKeys.notes) {
            NotesField(field: field, send: send)
        } else {
            PagePanel(page: state.page, placeholder: "item.media.notes.placeholder", send: send)
        }
    }
}

// MARK: - Values
private extension MediaItemContent {

    func field(_ key: String) -> FieldView? {
        state.fields.first { $0.propertyKey == key }
    }

    /// The properties the layout above does not show, without the ones Semp keeps about the cover.
    var details: [FieldView] {
        state.fields.filter { field in
            !MediaKeys.shownAbove.contains(field.propertyKey) && !field.propertyKey.hasPrefix(MediaKeys.coverPrefix)
        }
    }

    func selectedKey(of field: FieldView) -> String {
        if case .choices(let options) = field.content, let first = options.first { return first.key }
        return ""
    }

    func stars(of field: FieldView) -> Int {
        if case .number(let value) = field.content { return Int(value.rounded()) }
        return 0
    }

    /// The author and the year of a book, the year and the kind of a film.
    var meta: String? {
        metaParts.isEmpty ? nil : metaParts.joined(separator: " · ")
    }

    var metaParts: [String] {
        (header.databaseKey == DatabaseKey.books ? ["author", "year"] : ["year", "type"])
            .compactMap(field)
            .compactMap(Self.text)
    }

    /// The rating of the source Semp took a film's details from, with its site.
    var sourceRating: String? {
        guard let rating = field(MediaKeys.sourceRating), case .number(let value) = rating.content else { return nil }
        var text = String(format: String(localized: "item.media.sourceRating", bundle: .module), Int(value.rounded()))
        if case .link(let url)? = field(MediaKeys.sourceUrl)?.content, let host = URL(string: url)?.host() {
            text += " · " + host.replacingOccurrences(of: "www.", with: "")
        }
        return text
    }

    static func text(of field: FieldView) -> String? {
        switch field.content {
        case .text(let text): text.isEmpty ? nil : text
        case .number(let value): String(Int(value.rounded()))
        case .choices(let options): options.first?.label
        default: nil
        }
    }
}

/// The canonical property keys of the books and films databases this layout places.
private enum MediaKeys {

    static let status = "status"
    static let rating = "rating"
    static let watchedWith = "watchedWith"
    static let notes = "notes"
    static let sourceRating = "secondaryRating"
    static let sourceUrl = "sourceUrl"
    static let coverPrefix = "cover"
    static let shownAbove: Set<String> = [status, rating, watchedWith, notes, sourceRating, sourceUrl, "name"]
}
