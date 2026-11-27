import CoreKit

/// Sample states for the previews of the mail screens. They never reach the shared layer.
enum PreviewMail {

    // MARK: - Thread list
    static let threads = MailThreadsState(
        phase: .content,
        threads: [
            MailThreadItem(
                threadId: "t1",
                subject: "Re: Nabídka na web",
                lastMessageAt: "2026-10-20T12:41:00.000000Z",
                senderName: "Petr Novák",
                senderAddress: "petr@novak.cz",
                senderRelationship: "Klient",
                messageCount: 4,
                preview: "Díky, rozpočet nám sedí. Můžeme začít v listopadu? Posílám ještě podklady k logu.",
                hasAttachment: true,
                unread: true,
                flagged: true,
                mailboxNames: ["Gmail"],
                projectName: "Web pro klienta",
                hasSempDraft: true
            ),
            MailThreadItem(
                threadId: "t2",
                subject: "Fakturační údaje",
                lastMessageAt: "2026-10-19T09:30:00.000000Z",
                senderName: "Karel Zlatý",
                senderAddress: "karel@zlaty.cz",
                preview: "Dobrý den, posílám fakturační údaje naší pekárny pro smlouvu…",
                mailboxNames: ["Outlook"]
            )
        ],
        mailboxes: [MailMailboxChip(id: "m1", name: "Gmail"), MailMailboxChip(id: "m2", name: "Outlook")],
        reauthorization: [MailAccountNotice(id: "m1", name: "Gmail", since: "2026-10-20T09:12:00.000000Z")],
        facets: MailFacetsState(
            phase: .ready,
            projectTotal: 7,
            projects: [
                MailFilterOption(id: "p1", name: "Web pro klienta", color: "#FF9500", count: 3),
                MailFilterOption(id: "p2", name: "Rekonstrukce koupelny", color: "#AF52DE", count: 2)
            ]
        )
    )

    // MARK: - Thread
    static let thread = MailThreadState(
        phase: .content,
        subject: "Re: Nabídka na web",
        senderName: "Petr Novák",
        senderAddress: "petr@novak.cz",
        senderRelationship: "Klient",
        mailboxNames: ["Gmail"],
        messageCount: 2,
        flagged: true,
        company: MailLinkedValue(
            text: "Novák Web s.r.o.",
            link: MailLinkInfo(type: .inherited, sourceTitles: ["Petr Novák"], brokenByAgent: false)
        ),
        project: MailLinkedValue(
            text: "Web pro klienta",
            link: MailLinkInfo(type: .inherited, sourceTitles: ["Novák Web s.r.o."], brokenByAgent: false)
        ),
        messages: [
            MailMessageItem(
                emailId: "e1",
                fromName: "David Třešňák",
                fromAddress: "david@tresnak.cz",
                own: true,
                toNames: ["Petr Novák"],
                date: "2026-10-12T10:00:00.000000Z",
                bodyText: "Dobrý den,\nposílám nabídku na nový web včetně harmonogramu a rozpočtu."
            ),
            MailMessageItem(
                emailId: "e2",
                fromName: "Petr Novák",
                fromAddress: "petr@novak.cz",
                toNames: ["David Třešňák"],
                date: "2026-10-20T12:41:00.000000Z",
                bodyText: "Dobrý den, Davide,\n\ndíky, rozpočet nám sedí. Můžeme začít v listopadu?\n\nPetr",
                attachments: [
                    MailAttachmentItem(
                        attachmentId: "a1",
                        filename: "logo_zdroj.svg",
                        contentType: "image/svg+xml",
                        byteSize: 1_200_000,
                        project: MailLinkedValue(
                            text: "Web pro klienta",
                            link: MailLinkInfo(
                                type: .inherited,
                                sourceTitles: ["Re: Nabídka na web"],
                                brokenByAgent: false
                            )
                        ),
                        fileItemId: "f1"
                    )
                ],
                expanded: true
            )
        ],
        tasks: [
            MailTaskItem(
                id: "k1",
                name: "Poslat upravenou nabídku",
                date: "2026-10-23",
                project: MailLinkedValue(text: "Web pro klienta", link: nil),
                peopleNames: ["Petr Novák"],
                peopleLink: MailLinkInfo(type: .inherited, sourceTitles: ["Re: Nabídka na web"], brokenByAgent: false)
            )
        ],
        draft: MailSempDraft(
            id: "d1",
            body: "Dobrý den, Petře,\n\ndíky za potvrzení rozpočtu. Začít můžeme v pondělí 2. listopadu.",
            recipients: ["Petr Novák"]
        ),
        canReply: true
    )

    /// A thread of older messages the server holds only at the mail provider: one whose body failed, the newest one
    /// being fetched, with an attachment that was not saved and one being saved.
    static let remoteThread = MailThreadState(
        phase: .content,
        subject: "Smlouva 2023",
        senderName: "Karel Zlatý",
        senderAddress: "karel@zlaty.cz",
        mailboxNames: ["Outlook"],
        messageCount: 2,
        messages: [
            MailMessageItem(
                emailId: "e1",
                fromName: "Karel Zlatý",
                fromAddress: "karel@zlaty.cz",
                toNames: ["David Třešňák"],
                date: "2023-03-02T08:10:00.000000Z",
                preview: "Dobrý den, posílám návrh smlouvy k připomínkám.",
                bodyPhase: .failed,
                bodyFailure: .unavailable,
                bodyUnavailable: .providerUnreachable,
                expanded: true
            ),
            MailMessageItem(
                emailId: "e2",
                fromName: "Karel Zlatý",
                fromAddress: "karel@zlaty.cz",
                toNames: ["David Třešňák"],
                date: "2023-03-04T15:20:00.000000Z",
                preview: "Upravená verze je v příloze.",
                bodyPhase: .loading,
                attachments: [
                    MailAttachmentItem(
                        attachmentId: "a2",
                        filename: "smlouva_v2.pdf",
                        contentType: "application/pdf",
                        byteSize: 240_000,
                        project: MailLinkedValue(text: nil, link: nil),
                        savePhase: .failed,
                        saveFailure: .unavailable,
                        saveUnavailable: .attachmentTooLarge
                    ),
                    MailAttachmentItem(
                        attachmentId: "a3",
                        filename: "priloha.docx",
                        contentType: "application/msword",
                        byteSize: 52_000,
                        project: MailLinkedValue(text: nil, link: nil),
                        savePhase: .saving
                    )
                ],
                expanded: true
            )
        ],
        canReply: true
    )

    /// The thread list of a search, with what the provider search added.
    static let search: MailThreadsState = {
        var state = threads
        state.search = "nabídka"
        state.remoteSearch = MailRemoteSearchSummary(
            unindexed: 12,
            failedAccounts: [MailMailboxChip(id: "m2", name: "Outlook")]
        )
        return state
    }()

    // MARK: - Compose
    static let compose = MailComposeState(
        phase: .editing,
        senders: [
            MailSender(mailboxId: "m1", name: "Gmail", address: "david@gmail.com"),
            MailSender(mailboxId: "m2", name: "Outlook", address: "s@tresnak.cc")
        ],
        senderId: "m1",
        toRecipients: [MailRecipient(name: "Petr Novák", address: "petr@novak.cz")],
        initialSubject: "Re: Nabídka na web",
        initialBody: "Dobrý den, Petře,\n\n"
    )

    // MARK: - Folders
    static let folders = MailFoldersState(
        phase: .content,
        unreadInbox: 5,
        flagged: 2,
        sempDrafts: 2,
        accounts: [
            MailFolderAccount(
                id: "m1",
                name: "Gmail",
                address: "david@gmail.com",
                status: .needsReauthorization,
                folders: [
                    MailFolderItem(id: "f1", name: "Doručená pošta", specialPurpose: "inbox", unreadCount: 3),
                    MailFolderItem(id: "f2", name: "Odeslané", specialPurpose: "sent", unreadCount: 0),
                    MailFolderItem(id: "f3", name: "Klienti", specialPurpose: "none", unreadCount: 1)
                ]
            ),
            MailFolderAccount(
                id: "m2",
                name: "Outlook",
                address: "s@tresnak.cc",
                status: .ok,
                folders: [MailFolderItem(id: "f4", name: "Doručená pošta", specialPurpose: "inbox", unreadCount: 2)]
            )
        ]
    )
}
