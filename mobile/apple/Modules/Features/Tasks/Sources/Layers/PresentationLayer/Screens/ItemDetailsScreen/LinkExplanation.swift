import CoreKit
import DesignSystem
import SwiftUI

/// The value of an item that can be tied to another item.
enum LinkSubject: Equatable {

    case project
    case people
    /// The company of an event: always computed from its project, never followed or changed.
    case company

    var linkedValue: LinkedValue? {
        switch self {
        case .project: .project
        case .people: .people
        case .company: nil
        }
    }
}

/// The words of the small glass menu that tells what a value's chain means (Principles, "Tři druhy hodnot"): what
/// the value is, where it comes from, when the link ends, and the action that changes it.
enum LinkTexts {

    static func title(_ subject: LinkSubject, _ link: ValueLink) -> String {
        switch (link.state, subject) {
        case (.derived, _): String(localized: "link.derived.title", bundle: .module)
        case (.inherited, .people): String(localized: "link.inherited.people.title", bundle: .module)
        case (.inherited, _): String(localized: "link.inherited.project.title", bundle: .module)
        case (.broken, .people): String(localized: "link.broken.people.title", bundle: .module)
        case (.broken, _): String(localized: "link.broken.project.title", bundle: .module)
        }
    }

    static func text(_ subject: LinkSubject, _ link: ValueLink) -> String {
        let source = link.sourceTitle ?? String(localized: "link.unknownSource", bundle: .module)
        let format: String
        switch (link.state, subject) {
        case (.derived, _): return String(localized: "link.derived.text", bundle: .module)
        case (.inherited, .people): format = String(localized: "link.inherited.people.text", bundle: .module)
        case (.inherited, _): format = String(localized: "link.inherited.project.text", bundle: .module)
        case (.broken, .people):
            format = link.brokenBySemp
                ? String(localized: "link.broken.people.semp", bundle: .module)
                : String(localized: "link.broken.people.user", bundle: .module)
        case (.broken, _):
            format = link.brokenBySemp
                ? String(localized: "link.broken.project.semp", bundle: .module)
                : String(localized: "link.broken.project.user", bundle: .module)
        }
        return String(format: format, locale: .current, source)
    }
}

/// The chain next to a value: tap it to read what the link means and to end or renew it.
struct LinkPill: View {

    // MARK: - Dependencies
    let subject: LinkSubject
    let link: ValueLink
    let unlink: () -> Void
    let relink: () -> Void

    // MARK: - State
    @State private var open = false

    // MARK: - Body
    var body: some View {
        Button { open = true } label: {
            Image(systemName: symbol)
                .font(.footnote)
                .foregroundStyle(link.state == .inherited ? Theme.Colors.accent : Theme.Colors.secondaryText)
                .frame(width: 28, height: 28)
                .background(.thinMaterial, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(LinkTexts.title(subject, link))
        .glassPopover(isPresented: $open) {
            LinkExplanation(
                subject: subject,
                link: link,
                unlink: {
                    open = false
                    unlink()
                },
                relink: {
                    open = false
                    relink()
                }
            )
        }
    }
}

// MARK: - Private
private extension LinkPill {

    var symbol: String {
        switch link.state {
        case .inherited: "link"
        case .broken: "personalhotspot.slash"
        case .derived: "arrow.turn.down.right"
        }
    }
}

/// The content of the chain's popover.
struct LinkExplanation: View {

    // MARK: - Dependencies
    let subject: LinkSubject
    let link: ValueLink
    let unlink: () -> Void
    let relink: () -> Void

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Text(LinkTexts.title(subject, link)).font(.headline)
            Text(LinkTexts.text(subject, link)).font(.subheadline).foregroundStyle(Theme.Colors.secondaryText)
            if link.state == .inherited {
                Button(action: unlink) { Text("link.action.unlink", bundle: .module) }
                    .buttonStyle(.bordered)
            }
            if link.state == .broken {
                Button(action: relink) { Text("link.action.relink", bundle: .module) }
                    .buttonStyle(.bordered)
            }
        }
        .padding(Theme.Spacing.medium)
        .frame(minWidth: 260, maxWidth: 320, alignment: .leading)
    }
}
