import CoreKit
import DesignSystem
import SwiftUI

/// One thread: who it is with and which company and project it belongs to, the messages (the last one open), the tasks
/// made from it, the reply Semp prepared and the buttons to answer it. Flagging, archiving and deleting sit in the
/// toolbar.
struct MailThreadScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: MailThreadViewModel

    // MARK: - State
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> MailThreadViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text("mail.thread.title", bundle: .module))
            .inlineNavigationTitle()
            .toolbar { toolbar }
            .alert(
                Text("mail.failure.title", bundle: .module),
                isPresented: actionFailed,
                actions: { dismissButton },
                message: { Text("mail.failure.message", bundle: .module) }
            )
            .onChange(of: viewModel.closeRequests) { dismiss() }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(MailIdentifiers.threadScreen)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension MailThreadScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.message(for: failure)), retry: { viewModel.send(.retry) }))
        case .content:
            thread
        }
    }

    var thread: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                MailThreadHeader(state: viewModel.state)
                VStack(spacing: 0) {
                    ForEach(viewModel.state.messages) { message in
                        MailMessageCard(message: message) { viewModel.send(.toggleMessage(emailId: message.emailId)) }
                            .accessibilityIdentifier(MailIdentifiers.messagePrefix + message.emailId)
                        if message.id != viewModel.state.messages.last?.id { Divider().padding(.leading, 62) }
                    }
                }
                .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: Theme.Radius.card))
                MailTasksSection(
                    tasks: viewModel.state.tasks,
                    creating: viewModel.state.creatingTask,
                    open: { viewModel.send(.open(.task(taskId: $0))) },
                    add: { viewModel.send(.addTask) }
                )
                if viewModel.state.draft != nil || viewModel.state.sentFrom != nil {
                    MailSempDraftCard(state: viewModel.state) { viewModel.send($0) }
                }
            }
            .padding(.horizontal, Theme.Spacing.medium)
            .padding(.bottom, Theme.Spacing.large)
        }
        .background(Theme.Colors.groupedBackground)
        .refreshable { await viewModel.refresh() }
        .safeAreaInset(edge: .bottom) { if viewModel.state.canReply { replyBar } }
    }

    var replyBar: some View {
        HStack(spacing: Theme.Spacing.large) {
            replyButton("arrowshape.turn.up.left", "mail.reply", .reply, MailIdentifiers.reply)
            replyButton("arrowshape.turn.up.left.2", "mail.replyAll", .replyAll, MailIdentifiers.replyAll)
            replyButton("arrowshape.turn.up.right", "mail.forward", .forward, MailIdentifiers.forward)
        }
        .padding(.horizontal, Theme.Spacing.large)
        .padding(.vertical, Theme.Spacing.small)
        .glassEffect(.regular, in: .capsule)
        .padding(.bottom, Theme.Spacing.small)
    }

    func replyButton(_ symbol: String, _ label: LocalizedStringKey, _ mode: MailReplyMode, _ id: String) -> some View {
        Button { viewModel.send(.open(.reply(mode))) } label: {
            Image(systemName: symbol).font(.title3).frame(width: 36, height: 36)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label, bundle: .module))
        .accessibilityIdentifier(id)
    }

    @ToolbarContentBuilder var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            Button { viewModel.send(.toggleFlag) } label: {
                Label {
                    Text(viewModel.state.flagged ? "mail.unflag" : "mail.flag", bundle: .module)
                } icon: {
                    Image(systemName: viewModel.state.flagged ? "flag.fill" : "flag")
                }
            }
            .tint(viewModel.state.flagged ? .orange : nil)
            .accessibilityIdentifier(MailIdentifiers.threadFlag)
            if viewModel.state.archivedOrTrashed {
                moveButton(.restore, "mail.restore", "arrow.uturn.backward", MailIdentifiers.threadRestore)
            } else {
                moveButton(.archive, "mail.archive", "archivebox", MailIdentifiers.threadArchive)
            }
            moveButton(.trash, "mail.trash", "trash", MailIdentifiers.threadTrash)
        }
    }

    func moveButton(_ move: MailThreadMove, _ label: LocalizedStringKey, _ symbol: String, _ id: String) -> some View {
        Button { viewModel.send(.move(move)) } label: {
            Label { Text(label, bundle: .module) } icon: { Image(systemName: symbol) }
        }
        .disabled(viewModel.state.acting)
        .accessibilityIdentifier(id)
    }

    var dismissButton: some View {
        Button(role: .cancel) { viewModel.send(.dismissFailure) } label: { Text("state.ok", bundle: .module) }
    }

    var actionFailed: Binding<Bool> {
        Binding(get: { viewModel.state.actionFailed }, set: { if !$0 { viewModel.send(.dismissFailure) } })
    }
}

// MARK: - Preview
#Preview("Content") {
    NavigationStack {
        MailThreadScreen(
            viewModel: MailThreadViewModel(
                model: ScriptedMailThreadScreenModel(state: PreviewMail.thread),
                router: PreviewMailRouter()
            )
        )
    }
}
