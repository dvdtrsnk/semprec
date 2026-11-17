import CoreKit
import DesignSystem
import SwiftUI

/// Podrobnosti: the sheet that edits a task or an event. A task has done, day, times, repeat and a flag; an event
/// has a place, an all-day switch, start and end and a company derived from its project. Both have a description, a
/// project, people (attendees), attachments and delete. The pickers push inside the sheet. Text typed into a field
/// stays in this view until the field is left; the shared ViewModel gets it then.
struct ItemDetailsScreen: View {

    // MARK: - Dependencies
    @StateObject var viewModel: ItemDetailsViewModel
    /// Opens the page of the event this sheet edits; nil where the app has no such page. The sheet closes first.
    let openEventPage: (@MainActor () -> Void)?

    // MARK: - State
    @Environment(\.dismiss)
    private var dismiss
    @State var path: [ItemDetailsPage] = []
    @State private var titleDraft: String?
    @State private var descriptionDraft: String?
    @State private var placeDraft: String?
    @State private var confirmingDelete = false
    @FocusState private var focus: Field?

    enum TimeField: Hashable {
        case start
        case end
    }

    fileprivate enum Field: Hashable {
        case title
        case description
        case place
    }

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> ItemDetailsViewModel, openEventPage: (@MainActor () -> Void)? = nil) {
        _viewModel = StateObject(wrappedValue: viewModel())
        self.openEventPage = openEventPage
    }

    // MARK: - Body
    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle(Text("details.title", bundle: .module))
                .inlineNavigationTitle()
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { dismiss() } label: { Image(systemName: "xmark") }
                            .accessibilityLabel(Text("details.close", bundle: .module))
                            .accessibilityIdentifier(TasksIdentifiers.detailsClose)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button { dismiss() } label: { Image(systemName: "checkmark") }
                            .accessibilityLabel(Text("details.done", bundle: .module))
                    }
                }
                .navigationDestination(for: ItemDetailsPage.self) { page in pageView(page) }
        }
        .onChange(of: viewModel.deleted) { _, deleted in
            if deleted { dismiss() }
        }
        .alert(
            Text("tasks.notice.title", bundle: .module),
            isPresented: noticeShown,
            actions: {
                Button(role: .cancel) { viewModel.send(.dismissNotice) } label: {
                    Text("tasks.notice.ok", bundle: .module)
                }
            },
            message: { Text(FailureKind.message(for: viewModel.state.notice)) }
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(TasksIdentifiers.detailsScreen)
        .task { await viewModel.observe() }
    }
}

// MARK: - Content
private extension ItemDetailsScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.message(for: failure)), retry: { viewModel.send(.retry) }))
        case .content:
            form
        }
    }

    var form: some View {
        List {
            titleSection
            if isEvent, let openEventPage { eventPageSection(openEventPage) }
            scheduleSection
            relationsSection
            if !state.hostEvents.isEmpty { hostSection }
            if !state.files.isEmpty { filesSection }
            deleteSection
        }
        .groupedListStyle()
        .confirmationDialog(
            Text(isEvent ? "details.delete.askEvent" : "details.delete.askTask", bundle: .module),
            isPresented: $confirmingDelete,
            titleVisibility: .visible
        ) {
            Button(role: .destructive) { viewModel.send(.delete) } label: {
                Text(isEvent ? "details.delete.event" : "details.delete.task", bundle: .module)
            }
        } message: {
            Text(deleteImpact)
        }
    }

    var titleSection: some View {
        Section {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.small) {
                if !isEvent { doneButton }
                TextField(text: text(\.title, draft: $titleDraft), axis: .vertical) {
                    Text("details.titlePlaceholder", bundle: .module)
                }
                .font(.title3.weight(.semibold))
                .strikethrough(state.done)
                .foregroundStyle(state.done ? Theme.Colors.secondaryText : Color.primary)
                .focused($focus, equals: .title)
                .accessibilityIdentifier(TasksIdentifiers.detailsTitle)
            }
            if isEvent {
                TextField(text: text(\.place, draft: $placeDraft)) {
                    Text("details.place", bundle: .module)
                }
                .focused($focus, equals: .place)
            }
            TextField(text: text(\.description, draft: $descriptionDraft), axis: .vertical) {
                Text("details.description", bundle: .module)
            }
            .lineLimit(2...8)
            .focused($focus, equals: .description)
        }
        .onChange(of: focus) { old, _ in commit(old) }
    }

    func eventPageSection(_ open: @escaping @MainActor () -> Void) -> some View {
        Section {
            Button {
                dismiss()
                open()
            } label: {
                Label { Text("details.eventPage", bundle: .module) } icon: { Image(systemName: "doc.text") }
            }
            .listRowButton()
            .accessibilityIdentifier(TasksIdentifiers.detailsEventPage)
        }
    }

    var doneButton: some View {
        Button { viewModel.send(.toggleDone) } label: {
            Image(systemName: state.done ? "checkmark.circle.fill" : "circle")
                .font(.title2)
                .foregroundStyle(state.done ? Theme.Colors.accent : Theme.Colors.secondaryText)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(Text(state.done ? "details.markOpen" : "details.markDone", bundle: .module))
        .accessibilityIdentifier(TasksIdentifiers.detailsDone)
    }

    var deleteSection: some View {
        Section {
            Button(role: .destructive) { confirmingDelete = true } label: {
                Text(isEvent ? "details.delete.event" : "details.delete.task", bundle: .module)
                    .frame(maxWidth: .infinity)
            }
            .accessibilityIdentifier(TasksIdentifiers.detailsDelete)
        }
    }

    var hostSection: some View {
        Section {
            ForEach(state.hostEvents) { event in
                Label {
                    Text(inEventText(event.title))
                } icon: {
                    Image(systemName: "calendar")
                }
            }
        } footer: {
            Text("details.inEvent.hint", bundle: .module)
        }
    }

    var filesSection: some View {
        Section {
            ForEach(state.files) { file in
                HStack(spacing: Theme.Spacing.small) {
                    Image(systemName: "doc").foregroundStyle(Theme.Colors.secondaryText)
                    Text(file.title)
                    Spacer()
                    Button { viewModel.send(.removeFile(file.id)) } label: {
                        Image(systemName: "minus.circle").foregroundStyle(Theme.Colors.destructive)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(removeFileLabel(file.title))
                }
            }
        } header: {
            Text("details.files", bundle: .module)
        }
    }
}

// MARK: - State
extension ItemDetailsScreen {

    var state: ItemDetailsState { viewModel.state }
    var isEvent: Bool { state.kind == .event }
}

// MARK: - Private
private extension ItemDetailsScreen {

    var noticeShown: Binding<Bool> {
        Binding(get: { viewModel.state.notice != nil }, set: { if !$0 { viewModel.send(.dismissNotice) } })
    }

    var deleteImpact: String {
        if isEvent { return String(localized: "details.delete.impactEvent", bundle: .module) }
        let base = String(localized: "details.delete.impactTask", bundle: .module)
        switch state.files.count {
        case 0:
            return base
        case 1:
            return base + " " + String(localized: "details.delete.impactFile", bundle: .module)
        default:
            let files = String(localized: "details.delete.impactFiles", bundle: .module)
            return base + " " + String(format: files, locale: .current, state.files.count)
        }
    }

    func inEventText(_ title: String) -> String {
        String(format: String(localized: "details.inEvent", bundle: .module), locale: .current, title)
    }

    func removeFileLabel(_ name: String) -> String {
        String(format: String(localized: "details.removeFile", bundle: .module), locale: .current, name)
    }

    /// A field's text: what the person typed until the field is left, then what the shared state holds.
    func text(_ value: KeyPath<ItemDetailsState, String>, draft: Binding<String?>) -> Binding<String> {
        Binding(
            get: { draft.wrappedValue ?? viewModel.state[keyPath: value] },
            set: { draft.wrappedValue = $0 }
        )
    }

    /// Sends the text of the field that was just left, when it changed.
    func commit(_ field: Field?) {
        switch field {
        case .title: finish(&titleDraft, current: state.title, ItemDetailsAction.setTitle)
        case .description: finish(&descriptionDraft, current: state.description, ItemDetailsAction.setDescription)
        case .place: finish(&placeDraft, current: state.place, ItemDetailsAction.setPlace)
        case nil: break
        }
    }

    func finish(_ draft: inout String?, current: String, _ action: (String) -> ItemDetailsAction) {
        defer { draft = nil }
        guard let typed = draft, typed != current else { return }
        viewModel.send(action(typed))
    }

    @ViewBuilder
    func pageView(_ page: ItemDetailsPage) -> some View {
        switch page {
        case .project: ProjectPickerPage(state: state, send: viewModel.send, pick: { path.removeLast() })
        case .people: PeoplePickerPage(state: state, send: viewModel.send)
        case .repeats: RepeatPickerPage(state: state, send: viewModel.send, pick: { path.removeLast() })
        }
    }
}

// MARK: - Preview
#Preview("Task") {
    ItemDetailsScreen(viewModel: ItemDetailsViewModel(model: ScriptedItemDetailsScreenModel(state: .previewTask)))
}

#Preview("Event") {
    ItemDetailsScreen(viewModel: ItemDetailsViewModel(model: ScriptedItemDetailsScreenModel(state: .previewEvent)))
}

// MARK: - Preview content
extension ItemDetailsState {

    /// The canonical task of the boards, for previews.
    static var previewTask: ItemDetailsState {
        ItemDetailsState(
            phase: .content,
            kind: .task,
            title: "Odeslat fakturu",
            description: "Fakturu za září poslat Karlovi.",
            flagged: true,
            date: IsoDay.today(),
            timeFrom: "14:00",
            timeTo: "15:30",
            lengthMinutes: 90,
            project: ProjectRef(id: "p1", title: "Účetnictví a faktury", areaTitle: "Práce"),
            people: [EntityRef(id: "u1", title: "Karel Zlatý")],
            files: [EntityRef(id: "f1", title: "Faktura_2026-10.pdf")],
            projectLink: ValueLink(state: .inherited, sourceTitle: "Schůzka s účetní")
        )
    }

    static var previewEvent: ItemDetailsState {
        ItemDetailsState(
            phase: .content,
            kind: .event,
            title: "Schůzka s klientem",
            place: "Kancelář, Karlín",
            date: IsoDay.today(),
            timeFrom: "10:00",
            timeTo: "11:30",
            lengthMinutes: 90,
            project: ProjectRef(id: "p2", title: "Web pro klienta", areaTitle: "Práce"),
            people: [EntityRef(id: "u2", title: "Petr Novák")],
            company: EntityRef(id: "c1", title: "Novák Web s.r.o.")
        )
    }
}
