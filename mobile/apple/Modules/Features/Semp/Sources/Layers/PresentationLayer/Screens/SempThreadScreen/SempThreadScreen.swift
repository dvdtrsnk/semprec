import CoreKit
import DesignSystem
import SwiftUI

/// A conversation with Semp: the latest chat, a new one, a thread of the history, the thread of an Inbox item or the
/// thread of an automatic task. What the conversation holds and how a message goes out is decided in Kotlin; this
/// screen shows it and keeps the text being written.
struct SempThreadScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: SempThreadViewModel

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> SempThreadViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(title)
            .inlineNavigationTitle()
            .toolbar { toolbar }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(SempIdentifiers.thread)
            .alert(
                Text("semp.action.failed", bundle: .module),
                isPresented: actionFailed,
                actions: {
                    Button { viewModel.send(.dismissFailure) } label: { Text("semp.action.dismiss", bundle: .module) }
                },
                message: { Text(FailureKind.sempMessage(for: state.actionFailure?.kind)) }
            )
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension SempThreadScreen {

    var state: SempThreadState {
        viewModel.state
    }

    var title: String {
        switch state.type {
        case .chat: state.title ?? String(localized: "semp.thread.title", bundle: .module)
        case .item: String(localized: "semp.thread.item", bundle: .module)
        case .tick: state.tick?.name ?? state.title ?? String(localized: "semp.thread.tick", bundle: .module)
        }
    }

    var actionFailed: Binding<Bool> {
        Binding(get: { state.actionFailure != nil }, set: { _ in viewModel.send(.dismissFailure) })
    }

    @ViewBuilder var content: some View {
        switch state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.sempMessage(for: failure)), retry: viewModel.retry))
        case .ready:
            conversation
        }
    }

    var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if state.hasOlder { loadOlder }
                    header
                    if state.entries.isEmpty, state.type == .chat { SempEmptyChatView(send: viewModel.send) }
                    ForEach(state.entries) { entry in
                        SempEntryView(entry: entry, type: state.type, send: viewModel.send)
                    }
                    Color.clear.frame(height: 1).id(SempThreadScreen.bottom)
                }
                .padding(.horizontal, Theme.Spacing.medium)
                .padding(.top, Theme.Spacing.small)
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: state.entries.map(\.id)) { _, _ in
                withAnimation { proxy.scrollTo(SempThreadScreen.bottom, anchor: .bottom) }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let notice = state.notice { noticeBanner(notice) }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            SempComposerView(state: state, send: viewModel.send)
        }
    }

    static let bottom = "semp.thread.bottom"

    var loadOlder: some View {
        Button { viewModel.send(.loadOlder) } label: {
            if state.loadingOlder {
                ProgressView().controlSize(.small)
            } else {
                Text("semp.thread.loadOlder", bundle: .module)
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.Colors.accent)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier(SempIdentifiers.loadOlder)
    }

    @ViewBuilder var header: some View {
        switch state.type {
        case .item: SempSubjectHeader(subject: state.subject)
        case .tick:
            if let tick = state.tick { SempTickHeader(tick: tick, send: viewModel.send) }
        case .chat: EmptyView()
        }
    }

    func noticeBanner(_ notice: SempNotice) -> some View {
        HStack(spacing: 10) {
            Button { viewModel.send(.openStatus) } label: {
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.Colors.sempWaiting)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(notice.title).font(.subheadline.weight(.semibold))
                        Text(notice.text).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(SempIdentifiers.notice)
            Button { viewModel.send(.dismissNotice) } label: { Image(systemName: "xmark").foregroundStyle(.secondary) }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("semp.notice.hide", bundle: .module))
                .accessibilityIdentifier(SempIdentifiers.noticeClose)
        }
        .padding(12)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 18))
        .padding(.horizontal, Theme.Spacing.medium)
    }

    @ToolbarContentBuilder var toolbar: some ToolbarContent {
        if state.type != .tick {
            ToolbarItem(placement: .navigation) {
                Button { viewModel.send(.openHistory) } label: { Image(systemName: "text.alignleft") }
                    .accessibilityLabel(Text("semp.history.open", bundle: .module))
                    .accessibilityIdentifier(SempIdentifiers.history)
            }
            ToolbarItem(placement: .primaryAction) {
                Button { viewModel.send(.openNewChat) } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel(Text("semp.newChat.open", bundle: .module))
                    .accessibilityIdentifier(SempIdentifiers.newChat)
            }
        }
    }
}

// MARK: - Preview
#Preview("Chat") {
    NavigationStack {
        SempThreadScreen(
            viewModel: SempThreadViewModel(
                model: ScriptedSempThreadScreenModel(
                    state: SempThreadState(
                        phase: .ready,
                        entries: [
                            SempEntry(id: "u1", role: .user, text: "Co mám dnes v plánu?"),
                            SempEntry(id: "a1", role: .assistant, text: "Dnes tě čeká:\n- **14:00** faktura")
                        ]
                    )
                ),
                router: PreviewSempRouter()
            )
        )
    }
}
