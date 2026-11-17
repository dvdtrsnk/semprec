import CoreKit
import DesignSystem
import SwiftUI

/// The tasks made from a thread, each with its date, its project and its people, and the button that asks Semp for the
/// next one. A task opens in Podrobnosti, where it is ticked off and changed.
struct MailTasksSection: View {

    // MARK: - Dependencies
    let tasks: [MailTaskItem]
    let creating: Bool
    let open: (String) -> Void
    let add: () -> Void

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Text("mail.tasks.title", bundle: .module)
                .font(.title3.weight(.bold))
                .padding(.horizontal, Theme.Spacing.small)
                .accessibilityAddTraits(.isHeader)
            VStack(spacing: 0) {
                ForEach(tasks) { task in
                    row(task)
                    Divider().padding(.leading, 50)
                }
                addButton
            }
            .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: Theme.Radius.card))
            Text("mail.tasks.footer", bundle: .module)
                .font(.footnote)
                .foregroundStyle(Theme.Colors.secondaryText)
                .padding(.horizontal, Theme.Spacing.small)
        }
    }
}

// MARK: - Subviews
private extension MailTasksSection {

    func row(_ task: MailTaskItem) -> some View {
        Button { open(task.id) } label: {
            HStack(alignment: .top, spacing: Theme.Spacing.small + 4) {
                Image(systemName: task.done ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(task.done ? Theme.Colors.accent : Theme.Colors.secondaryText)
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: task.name)
                        .strikethrough(task.done)
                        .foregroundStyle(task.done ? Theme.Colors.secondaryText : .primary)
                    Text(verbatim: dueText(task)).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                    HStack(spacing: 6) {
                        MailLinkChip(text: task.project.text ?? noProject, link: task.project.link)
                        MailLinkChip(text: people(task), link: task.peopleLink)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(Theme.Spacing.medium)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(MailIdentifiers.taskPrefix + task.id)
    }

    var addButton: some View {
        Button(action: add) {
            HStack {
                if creating { ProgressView() } else { Image(systemName: "plus") }
                Text(creating ? "mail.tasks.adding" : "mail.tasks.add", bundle: .module)
                Spacer(minLength: 0)
            }
            .padding(Theme.Spacing.medium)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(creating)
        .accessibilityIdentifier(MailIdentifiers.addTask)
    }

    var noProject: String {
        String(localized: "mail.thread.noProject", bundle: .module)
    }

    func dueText(_ task: MailTaskItem) -> String {
        guard let date = task.date, let day = try? Date(date, strategy: .iso8601.year().month().day()) else {
            return String(localized: "mail.tasks.noDate", bundle: .module)
        }
        return day.formatted(.dateTime.weekday(.abbreviated).day().month())
    }

    /// The people of the conversation the task follows: none, the name of one, or how many.
    func people(_ task: MailTaskItem) -> String {
        switch task.peopleNames.count {
        case 0: String(localized: "mail.tasks.nobody", bundle: .module)
        case 1: task.peopleNames[0]
        default:
            String(
                format: String(localized: "mail.tasks.people", bundle: .module),
                locale: .current,
                task.peopleNames.count
            )
        }
    }
}
