import CoreKit

/// Cards for previews: a task to approve, and the stack behind it.
enum InboxPreviewData {

    static let task = InboxCard(
        id: "task",
        type: .task,
        origin: InboxOrigin(
            kind: .capture,
            text: "Tomorrow at 9 send the invoice to Alza for September.",
            date: "2026-10-16",
            time: "08:12",
            typeLabel: "Task",
            attachments: [InboxAttachment(id: "a1", name: "Invoice.pdf", mediaType: "application/pdf")]
        ),
        targets: ["Tasks"],
        groups: [
            InboxGroup(
                key: "main",
                fields: [
                    InboxField(
                        key: "name",
                        type: .text,
                        label: "Name",
                        required: true,
                        text: "Send the invoice to Alza"
                    ),
                    InboxField(
                        key: "date",
                        type: .datetime,
                        label: "Date",
                        date: "2026-10-17",
                        time: "09:00",
                        showTime: true
                    ),
                    InboxField(key: "allDay", type: .toggle, label: "All day"),
                    InboxField(
                        key: "project",
                        type: .select,
                        label: "Project",
                        selected: [InboxChoice(id: "p1", label: "Accounting", color: "#34C759", selected: true)],
                        needsPicker: true
                    )
                ]
            )
        ]
    )

    static let content = InboxContent(
        cards: [
            task,
            InboxCard(id: "second", type: .person),
            InboxCard(id: "third", type: .event)
        ]
    )
}
