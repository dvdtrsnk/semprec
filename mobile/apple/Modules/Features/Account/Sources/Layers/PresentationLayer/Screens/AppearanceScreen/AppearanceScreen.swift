import DesignSystem
import SwiftUI

/// The look of the app on this device: light, dark or the system's, shown as three small phones, and the accent
/// colour of its controls. Both are kept on the device and apply at once.
struct AppearanceScreen: View {

    // MARK: - State
    @AppStorage(AppAppearanceKeys.colorScheme)
    private var scheme = AppColorScheme.system
    @AppStorage(AppAppearanceKeys.accent)
    private var accent = AppAccent.blue

    // MARK: - Body
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.large) {
                HStack(spacing: Theme.Spacing.medium) {
                    ForEach(AppColorScheme.allCases, id: \.self) { option in schemeOption(option) }
                }
                .padding(Theme.Spacing.medium)
                .background(Theme.Colors.card, in: .rect(cornerRadius: 22))
                VStack(alignment: .leading, spacing: 4) {
                    Text("appearance.accent", bundle: .module).font(.title3.weight(.semibold))
                    Text("appearance.accent.detail", bundle: .module)
                        .font(.subheadline)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                .padding(.horizontal, 4)
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 5), spacing: 14) {
                    ForEach(AppAccent.allCases, id: \.self) { option in accentOption(option) }
                }
                .padding(Theme.Spacing.medium)
                .background(Theme.Colors.card, in: .rect(cornerRadius: 22))
            }
            .padding(Theme.Spacing.medium)
        }
        .background(Theme.Colors.groupedBackground)
        .navigationTitle(Text("appearance.title", bundle: .module))
        .inlineNavigationTitle()
        .sensoryFeedback(.selection, trigger: scheme)
        .sensoryFeedback(.selection, trigger: accent)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AccountIdentifiers.appearance)
    }
}

// MARK: - Subviews
private extension AppearanceScreen {

    func schemeOption(_ option: AppColorScheme) -> some View {
        let isSelected = option == scheme
        return Button { scheme = option } label: {
            VStack(spacing: Theme.Spacing.small) {
                AppearancePhone(scheme: option, accent: accent.color)
                    .padding(4)
                    .overlay(
                        RoundedRectangle(cornerRadius: 20)
                            .strokeBorder(isSelected ? accent.color : .clear, lineWidth: 2.5)
                    )
                Text(schemeTitle(option), bundle: .module)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(isSelected ? accent.color : .primary)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    func accentOption(_ option: AppAccent) -> some View {
        let isSelected = option == accent
        return Button { accent = option } label: {
            Circle()
                .fill(option.color)
                .padding(isSelected ? 5 : 0)
                .overlay(Circle().strokeBorder(isSelected ? option.color : .clear, lineWidth: 2.5))
                .aspectRatio(1, contentMode: .fit)
                .frame(maxWidth: 52)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(accentTitle(option), bundle: .module))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    func schemeTitle(_ option: AppColorScheme) -> LocalizedStringKey {
        switch option {
        case .system: "appearance.scheme.system"
        case .light: "appearance.scheme.light"
        case .dark: "appearance.scheme.dark"
        }
    }

    func accentTitle(_ option: AppAccent) -> LocalizedStringKey {
        switch option {
        case .blue: "appearance.accent.blue"
        case .cyan: "appearance.accent.cyan"
        case .teal: "appearance.accent.teal"
        case .mint: "appearance.accent.mint"
        case .yellow: "appearance.accent.yellow"
        case .orange: "appearance.accent.orange"
        case .pink: "appearance.accent.pink"
        case .purple: "appearance.accent.purple"
        case .indigo: "appearance.accent.indigo"
        case .gray: "appearance.accent.gray"
        }
    }
}

/// A small phone showing a page in `scheme`: light, dark, or half of each for the system's.
private struct AppearancePhone: View {

    let scheme: AppColorScheme
    let accent: Color

    var body: some View {
        ZStack {
            switch scheme {
            case .light: screen(dark: false)
            case .dark: screen(dark: true)
            case .system:
                screen(dark: false)
                screen(dark: true).mask(HStack(spacing: 0) { Color.clear; Color.black })
            }
        }
        .frame(height: 140)
    }

    func screen(dark: Bool) -> some View {
        let page = dark ? Color(white: 0.13) : .white
        let line = dark ? Color(white: 0.35) : Color(white: 0.85)
        return RoundedRectangle(cornerRadius: 16)
            .fill(page)
            .overlay(alignment: .topLeading) {
                VStack(alignment: .leading, spacing: 6) {
                    Capsule().fill(dark ? Color(white: 0.7) : Color(white: 0.4)).frame(width: 28, height: 4)
                    ForEach(0..<2, id: \.self) { _ in Capsule().fill(line).frame(height: 3) }
                    ForEach(0..<2, id: \.self) { _ in
                        HStack(spacing: 4) {
                            RoundedRectangle(cornerRadius: 1.5).fill(accent).frame(width: 7, height: 7)
                            Capsule().fill(line).frame(height: 3)
                        }
                    }
                }
                .padding(.horizontal, 10)
                .padding(.top, 22)
            }
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color(white: 0.5).opacity(0.3), lineWidth: 1))
    }
}
