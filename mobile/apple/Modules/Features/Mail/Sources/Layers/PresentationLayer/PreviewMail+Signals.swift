import CoreKit

// MARK: - Mail signals
extension PreviewMail {

    static let signals = ProjectMailSignalsState(
        phase: .ready,
        people: [
            MailSignalPersonItem(personId: "u1", name: "Petr Novák", address: "petr@novak.cz"),
            MailSignalPersonItem(personId: "u2", name: "Jana Zlatá", address: "jana@pekarna.cz")
        ],
        domains: ["pekarna.cz"],
        addresses: ["objednavky@dodavatel.cz"],
        keywords: ["faktura", "smlouva o dílo"],
        preview: MailSignalsPreviewState(
            phase: .ready,
            total: 64,
            alreadyAssigned: 5,
            threads: [
                MailSignalThreadItem(
                    threadId: "t1",
                    subject: "Faktura za říjen",
                    senderName: "Jana Zlatá",
                    senderAddress: "jana@pekarna.cz",
                    lastMessageAt: "2026-11-20T09:30:00.000000Z"
                ),
                MailSignalThreadItem(
                    threadId: "t2",
                    subject: "Re: Smlouvy o dílo",
                    senderName: "",
                    senderAddress: "objednavky@dodavatel.cz",
                    lastMessageAt: "2026-11-12T15:02:00.000000Z"
                )
            ]
        ),
        assignment: MailSignalsAssignment(assigned: 12, skipped: 1),
        canAssign: true
    )

    static let unsavedSignals = ProjectMailSignalsState(
        phase: .ready,
        domains: ["pekarna.cz", "novak.cz"],
        domainInput: "localhost",
        invalidField: .domains,
        unsaved: true,
        preview: MailSignalsPreviewState(phase: .loading, total: 3, threads: []),
        canSave: true
    )
}
