import CoreKit
import DesignSystem
import SwiftUI

/// The profile and settings of the account: who is signed in, the rows that lead to the account screens, the language
/// of Semp, the password-reset link and the sign-out. A failed summary leaves the identity and the sign-out usable.
struct ProfileScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: ProfileViewModel
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - State
    @State private var confirmsSignOut = false

    // MARK: - Init
    /// `viewModel` runs once per screen, when SwiftUI creates the state object.
    init(viewModel: @autoclosure @escaping () -> ProfileViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        Form {
            identity
            if let figures = viewModel.state.figures {
                rows(figures)
            } else if viewModel.state.phase == .error {
                failure
            }
            account
            data
            signOut
            footer
        }
        .formStyle(.grouped)
        .navigationTitle(Text("profile.title", bundle: .module))
        .inlineNavigationTitle()
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button { dismiss() } label: { Text("profile.done", bundle: .module) }
                    .accessibilityIdentifier(AccountIdentifiers.profileDone)
            }
        }
        .confirmationDialog(
            Text("profile.signOut.confirm", bundle: .module),
            isPresented: $confirmsSignOut,
            titleVisibility: .visible
        ) {
            Button(role: .destructive) { viewModel.signOut() } label: { Text("profile.signOut", bundle: .module) }
        }
        .alert(
            Text("profile.failed.title", bundle: .module),
            isPresented: Binding(get: { viewModel.state.writeFailure != nil }, set: { _ in viewModel.dismissFailure() })
        ) {
            Button(role: .cancel) {} label: { Text("common.ok", bundle: .module) }
        } message: {
            Text(FailureKind.message(for: viewModel.state.writeFailure?.kind))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AccountIdentifiers.profileScreen)
        .task { await viewModel.observe() }
    }
}

/// The tile of a row: the symbol of what it leads to on a color.
private struct ProfileTile {

    let symbol: String
    let color: Color
}

// MARK: - Subviews
private extension ProfileScreen {

    var identity: some View {
        Section {
            HStack(spacing: Theme.Spacing.medium) {
                Text(AccountFormat.initials(name: viewModel.state.name, email: viewModel.state.email))
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.background)
                    .frame(width: 64, height: 64)
                    .background(Theme.Colors.brand, in: Circle())
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: viewModel.state.name ?? viewModel.state.email ?? "").font(.headline)
                    if let detail = identityDetail {
                        Text(verbatim: detail).font(.subheadline).foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
            }
        }
    }

    /// Under the name, the address of the account; without a name the address is the title, and the server is below.
    var identityDetail: String? {
        viewModel.state.name == nil ? AccountFormat.host(of: viewModel.state.serverUrl) : viewModel.state.email
    }

    var failure: some View {
        Section {
            VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                Text(FailureKind.message(for: viewModel.state.failure)).foregroundStyle(Theme.Colors.secondaryText)
                Button { viewModel.retry() } label: { Text("common.retry", bundle: .module) }
            }
        }
    }

    func rows(_ figures: ProfileFigures) -> some View {
        Section {
            row(
                .sempStatus,
                ProfileTile(symbol: "waveform.path.ecg", color: .orange),
                title: "profile.row.semp",
                value: nil,
                subtitle: sempSubtitle(figures)
            )
            row(
                .notifications,
                ProfileTile(symbol: "bell.fill", color: .red),
                title: "profile.row.notifications",
                value: nil,
                subtitle: nil
            )
            row(.aiUsage, ProfileTile(symbol: "sparkles", color: .purple), title: "profile.row.aiUsage",
                value: AccountFormat.usd(figures.aiCostMonthUsd),
                subtitle: nil
            )
        }
    }

    var account: some View {
        Section {
            LabeledContent {
                Menu {
                    ForEach(viewModel.state.locales, id: \.self) { locale in
                        Button { viewModel.changeLocale(locale) } label: { Text(languageName(locale)) }
                    }
                } label: {
                    Text(languageName(viewModel.state.locale ?? ""))
                }
                .disabled(viewModel.state.localeSaving)
                .accessibilityIdentifier(AccountIdentifiers.profileLanguage)
            } label: {
                tile(ProfileTile(symbol: "globe", color: .blue), title: "profile.row.language", subtitle: nil)
            }
            Button { viewModel.requestPasswordReset() } label: {
                tile(
                    ProfileTile(symbol: "key.fill", color: .gray),
                    title: "profile.row.password",
                    subtitle: passwordSubtitle
                )
            }
            .listRowButton()
            .disabled(viewModel.state.resetPhase == .sending || viewModel.state.email == nil)
            .accessibilityIdentifier(AccountIdentifiers.profilePassword)
            row(.appearance, ProfileTile(symbol: "paintpalette.fill", color: .pink), title: "profile.row.appearance",
                value: nil,
                subtitle: nil
            )
            row(.devices, ProfileTile(symbol: "laptopcomputer.and.iphone", color: .teal), title: "profile.row.devices",
                value: viewModel.state.figures.map { String($0.activeSessions) },
                subtitle: nil
            )
        } header: {
            Text("profile.section.account", bundle: .module)
        }
    }

    var data: some View {
        Section {
            row(.mailAccounts, ProfileTile(symbol: "envelope.fill", color: .blue), title: "profile.row.mail",
                value: viewModel.state.figures.map { String($0.mailAccountCount) },
                subtitle: mailSubtitle
            )
            row(.trash, ProfileTile(symbol: "trash.fill", color: .gray), title: "profile.row.trash",
                value: viewModel.state.figures.map { String($0.trashCount) },
                subtitle: nil
            )
        } header: {
            Text("profile.section.data", bundle: .module)
        }
    }

    var signOut: some View {
        Section {
            Button(role: .destructive) { confirmsSignOut = true } label: {
                Text("profile.signOut", bundle: .module).frame(maxWidth: .infinity)
            }
            .accessibilityIdentifier(AccountIdentifiers.profileSignOut)
        }
    }

    @ViewBuilder var footer: some View {
        if let host = AccountFormat.host(of: viewModel.state.serverUrl) {
            Section {} footer: {
                Text(String(format: String(localized: "profile.server", bundle: .module), host))
                    .frame(maxWidth: .infinity)
            }
        }
    }

    func row(
        _ page: AccountPage,
        _ tile: ProfileTile,
        title: LocalizedStringKey,
        value: String?,
        subtitle: String?
    ) -> some View {
        Button { viewModel.open(page) } label: {
            HStack {
                self.tile(tile, title: title, subtitle: subtitle)
                Spacer(minLength: Theme.Spacing.small)
                if let value {
                    Text(verbatim: value).foregroundStyle(Theme.Colors.secondaryText)
                }
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .listRowButton()
        .foregroundStyle(.primary)
        .accessibilityIdentifier(AccountIdentifiers.profileRowPrefix + identifier(page))
    }

    func tile(_ tile: ProfileTile, title: LocalizedStringKey, subtitle: String?) -> some View {
        HStack(spacing: Theme.Spacing.medium) {
            Image(systemName: tile.symbol)
                .font(.callout)
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background(tile.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title, bundle: .module)
                if let subtitle {
                    Text(subtitle).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
        }
    }

    func languageName(_ locale: String) -> String {
        switch locale {
        case "cs": String(localized: "profile.language.cs", bundle: .module)
        case "en": String(localized: "profile.language.en", bundle: .module)
        default: locale
        }
    }

    func sempSubtitle(_ figures: ProfileFigures) -> String {
        figures.problemCount == 0
            ? String(localized: "profile.semp.ok", bundle: .module)
            : String(format: String(localized: "profile.semp.problems", bundle: .module), figures.problemCount)
    }

    var passwordSubtitle: String? {
        switch viewModel.state.resetPhase {
        case .idle, .sending: nil
        case .sent: String(
            format: String(localized: "profile.password.sent", bundle: .module),
            viewModel.state.email ?? ""
        )
        case .failed: String(localized: "profile.password.failed", bundle: .module)
        }
    }

    var mailSubtitle: String? {
        guard let reauth = viewModel.state.figures?.mailAccountsNeedingReauth, reauth > 0 else { return nil }
        return String(format: String(localized: "profile.mail.reauth", bundle: .module), reauth)
    }

    func identifier(_ page: AccountPage) -> String {
        switch page {
        case .devices: "devices"
        case .notifications: "notifications"
        case .aiUsage: "aiUsage"
        case .trash: "trash"
        case .sempStatus: "sempStatus"
        case .mailAccounts: "mailAccounts"
        case .appearance: "appearance"
        }
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        ProfileScreen(
            viewModel: ProfileViewModel(
                model: ScriptedProfileScreenModel(
                    state: ProfileState(
                        phase: .content,
                        email: "david.tresnak@example.cz",
                        serverUrl: "https://semprec.example.cz",
                        locale: "cs",
                        locales: ["cs", "en"],
                        figures: ProfileFigures(
                            activeSessions: 4,
                            mailAccountCount: 2,
                            mailAccountsNeedingReauth: 1,
                            trashCount: 7,
                            problemCount: 2,
                            aiCostMonthUsd: 24.12
                        )
                    )
                ),
                router: PreviewAccountRouter()
            )
        )
    }
}
