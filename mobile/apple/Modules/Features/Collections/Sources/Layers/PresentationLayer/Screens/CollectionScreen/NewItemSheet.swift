import DesignSystem
import SwiftUI

/// The sheet the add button opens: the name of the new item, with a confirm button that creates it. A book or a film
/// needs only its name, because Semp fills in the rest; the item of any other collection opens after it is created,
/// where its properties are filled in.
struct NewItemSheet: View {

    // MARK: - Dependencies
    let databaseKey: String?
    let databaseName: String
    let create: (String) -> Void
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - State
    @State private var name = ""
    @FocusState private var focused: Bool

    // MARK: - Body
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(text: $name) { placeholder }
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit(save)
                        .accessibilityIdentifier(CollectionsIdentifiers.newItemField)
                } footer: {
                    hint
                }
            }
            .navigationTitle(title)
            .inlineNavigationTitle()
            .toolbar {
                PlainToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(role: .confirm, action: save)
                        .disabled(trimmed.isEmpty)
                        .accessibilityIdentifier(CollectionsIdentifiers.newItemSave)
                }
            }
        }
        .presentationDetents([.medium])
        .onAppear { focused = true }
        .accessibilityIdentifier(CollectionsIdentifiers.newItemSheet)
    }
}

// MARK: - Subviews
private extension NewItemSheet {

    var title: Text {
        switch databaseKey {
        case DatabaseKey.books: Text("collection.add.book", bundle: .module)
        case DatabaseKey.movies: Text("collection.add.movie", bundle: .module)
        default: Text(String(format: String(localized: "collection.add.item", bundle: .module), databaseName))
        }
    }

    var placeholder: Text {
        switch databaseKey {
        case DatabaseKey.books: Text("collection.add.book.placeholder", bundle: .module)
        case DatabaseKey.movies: Text("collection.add.movie.placeholder", bundle: .module)
        default: Text("collection.new.placeholder", bundle: .module)
        }
    }

    var hint: Text {
        switch databaseKey {
        case DatabaseKey.books: Text("collection.add.book.hint", bundle: .module)
        case DatabaseKey.movies: Text("collection.add.movie.hint", bundle: .module)
        default: Text("collection.add.item.hint", bundle: .module)
        }
    }

    var trimmed: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func save() {
        guard !trimmed.isEmpty else { return }
        create(trimmed)
        dismiss()
    }
}

// MARK: - Preview
#Preview {
    NewItemSheet(databaseKey: "books", databaseName: "Knihy") { _ in }
}
