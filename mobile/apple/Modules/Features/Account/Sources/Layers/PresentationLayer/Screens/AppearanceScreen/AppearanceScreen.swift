import DesignSystem
import SwiftUI

/// The look of the app on this device: light, dark or the system's, shown as three small phones. The choice is kept
/// on the device and applies at once.
struct AppearanceScreen: View {

    // MARK: - State
    @AppStorage(AppAppearanceKeys.colorScheme)
    private var scheme = AppColorScheme.system

    // MARK: - Body
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.large) {
                HStack(spacing: Theme.Spacing.medium) {
                    ForEach(AppColorScheme.allCases, id: \.self) { option in schemeOption(option) }
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
                AppearancePhone(scheme: option, accent: Theme.Colors.appAccent)
                    .padding(4)
                    .overlay(
                        RoundedRectangle(cornerRadius: 20)
                            .strokeBorder(isSelected ? Theme.Colors.appAccent : .clear, lineWidth: 2.5)
                    )
                Text(schemeTitle(option), bundle: .module)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(isSelected ? Theme.Colors.appAccent : .primary)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    func schemeTitle(_ option: AppColorScheme) -> LocalizedStringKey {
        switch option {
        case .system: "appearance.scheme.system"
        case .light: "appearance.scheme.light"
        case .dark: "appearance.scheme.dark"
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
