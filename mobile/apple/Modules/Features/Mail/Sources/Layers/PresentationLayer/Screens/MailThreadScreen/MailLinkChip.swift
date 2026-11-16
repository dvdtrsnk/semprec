import CoreKit
import DesignSystem
import SwiftUI

/// The words of the small glass menu that tells what a chip's chain means (Principles, "Tři druhy hodnot"): what the
/// value is, where it comes from and when the link ends.
enum MailLinkTexts {

    static func title(_ link: MailLinkInfo) -> String {
        switch link.type {
        case .inherited: String(localized: "mail.link.inherited.title", bundle: .module)
        case .broken: String(localized: "mail.link.broken.title", bundle: .module)
        case .derived: String(localized: "mail.link.derived.title", bundle: .module)
        }
    }

    static func text(_ link: MailLinkInfo) -> String {
        let source = link.sourceTitles.first ?? String(localized: "mail.link.unknownSource", bundle: .module)
        let format: String
        switch link.type {
        case .derived:
            return String(localized: "mail.link.derived.text", bundle: .module)
        case .inherited:
            format = String(localized: "mail.link.inherited.text", bundle: .module)
        case .broken:
            format = link.brokenByAgent
                ? String(localized: "mail.link.broken.semp", bundle: .module)
                : String(localized: "mail.link.broken.user", bundle: .module)
        }
        return String(format: format, locale: .current, source)
    }

    static func symbol(_ link: MailLinkInfo) -> String {
        switch link.type {
        case .inherited: "link"
        case .broken: "personalhotspot.slash"
        case .derived: "arrow.turn.down.right"
        }
    }
}

/// A value of a thread, a file or a task as a capsule. A value that follows another item shows its chain, and a tap on
/// the capsule opens the small glass menu that says where the value comes from.
struct MailLinkChip: View {

    // MARK: - Dependencies
    let text: String
    let link: MailLinkInfo?

    // MARK: - State
    @State private var open = false

    // MARK: - Body
    var body: some View {
        if let link {
            Button { open = true } label: { label(link) }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(verbatim: "\(text), \(MailLinkTexts.title(link))"))
                .glassPopover(isPresented: $open) { explanation(link) }
        } else {
            label(nil)
        }
    }
}

// MARK: - Subviews
private extension MailLinkChip {

    func label(_ link: MailLinkInfo?) -> some View {
        HStack(spacing: 4) {
            if let link {
                Image(systemName: MailLinkTexts.symbol(link)).font(.caption2)
            }
            Text(verbatim: text).font(.caption.weight(.medium)).lineLimit(1)
        }
        .foregroundStyle(foreground(link))
        .padding(.horizontal, Theme.Spacing.small)
        .padding(.vertical, 4)
        .background(background(link), in: Capsule())
    }

    func explanation(_ link: MailLinkInfo) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Text(verbatim: MailLinkTexts.title(link)).font(.headline)
            Text(verbatim: MailLinkTexts.text(link))
                .font(.subheadline)
                .foregroundStyle(Theme.Colors.secondaryText)
        }
        .padding(Theme.Spacing.medium)
        .frame(minWidth: 260, maxWidth: 320, alignment: .leading)
    }

    func foreground(_ link: MailLinkInfo?) -> Color {
        link?.type == .inherited ? Theme.Colors.accent : Theme.Colors.secondaryText
    }

    func background(_ link: MailLinkInfo?) -> Color {
        link?.type == .inherited ? Theme.Colors.accent.opacity(0.12) : Color.secondary.opacity(0.12)
    }
}

// MARK: - Preview
#Preview {
    VStack {
        MailLinkChip(
            text: "Novák Web",
            link: MailLinkInfo(type: .inherited, sourceTitles: ["Petr Novák"], brokenByAgent: false)
        )
        MailLinkChip(
            text: "Web",
            link: MailLinkInfo(type: .broken, sourceTitles: ["Novák Web"], brokenByAgent: true)
        )
        MailLinkChip(text: "Bez projektu", link: nil)
    }
    .padding()
}
