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
            areaTotal: 9,
            projectTotal: 7,
            areas: [
                MailFilterOption(id: "a1", name: "Práce", color: "#5856D6", count: 5),
                MailFilterOption(id: "a2", name: "Domácnost", color: "#FF9500", count: 4)
            ],
            projects: [
                MailFilterOption(id: "p1", name: "Web pro klienta", color: "#FF9500", count: 3, areaId: "a1"),
                MailFilterOption(id: "p2", name: "Rekonstrukce koupelny", color: "#AF52DE", count: 2, areaId: "a2")
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
                        )
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

    // MARK: - Accounts
    static let accounts = MailAccountsState(
        phase: .content,
        accounts: [
            MailAccountItem(
                id: "m1",
                name: "Gmail",
                address: "david@gmail.com",
                provider: "gmail",
                status: .needsReauthorization
            ),
            MailAccountItem(id: "m2", name: "Outlook", address: "s@tresnak.cc", provider: "outlook", status: .ok)
        ]
    )

    static let account = MailAccountState(
        phase: .content,
        account: MailAccountDetail(
            id: "m2",
            name: "Outlook",
            address: "s@tresnak.cc",
            provider: "outlook",
            syncMode: "imap",
            status: .ok,
            lastSuccessfulSyncAt: "2026-10-20T12:30:00.000000Z",
            failingSince: nil,
            connectionLimit: 5,
            connectionLimitApplies: true,
            autonomousSendProjectCount: 1
        )
    )
}
