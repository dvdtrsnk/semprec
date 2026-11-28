import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the mappings of the calendars sheet, the invitations sheet and the new item form.
@MainActor
final class SharedCalendarSheetMappingTests: XCTestCase {

    // MARK: - Calendars list
    func testTheListMapsEveryPhase() {
        typealias Model = SharedCalendarListScreenModel
        XCTAssertEqual(Model.state(CalendarKotlin.listState(.loading)).phase, .loading)
        XCTAssertEqual(Model.state(CalendarKotlin.listState(.content)).phase, .content)
        XCTAssertEqual(
            Model.state(CalendarKotlin.listState(.error, failure: .unavailable)).phase,
            .failure(.unavailable)
        )
        XCTAssertEqual(Model.state(CalendarKotlin.listState(.error)).phase, .failure(nil))
    }

    func testTheListMapsRowsSwatchesDetailAndImpact() {
        let state = SharedCalendarListScreenModel.state(CalendarKotlin.listState(.content))
        XCTAssertEqual(
            state.calendars,
            [CoreKit.CalendarRow(
                id: "c1", name: "Work", color: "#007AFF", hidden: true, notify: false, group: .own, systemKey: nil,
                isDefault: true, canRename: false, canDelete: true
            )]
        )
        XCTAssertEqual(
            state.accounts,
            [
                CoreKit.CalendarAccountSection(
                    id: "m1", name: "Gmail", provider: "gmail", status: .needsConsent, address: "me@gmail.com"
                ),
                CoreKit.CalendarAccountSection(id: "")
            ]
        )
        XCTAssertEqual(state.swatches, [CoreKit.CalendarSwatch(key: "red", hex: "#FF3B30")])
        XCTAssertEqual(state.detailId, "c1")
        XCTAssertEqual(
            state.impact,
            CoreKit.CalendarImpact(calendarId: "c1", eventCount: 4, recipientCount: 2, cancellationCount: 1)
        )
        XCTAssertTrue(state.busy)
        XCTAssertTrue(state.problem)
        XCTAssertEqual(state.problemFailure, .rejected)
    }

    func testCalendarGroupsMapOneToOne() {
        let groups: [SharedSDK.CalendarGroup] = [.own, .system, .subscription, .account]
        XCTAssertEqual(groups.map { CoreKit.CalendarGroup($0) }, [.own, .system, .subscription, .account])
    }

    func testAnAccountRowMapsItsAccountAndProviderValues() {
        XCTAssertEqual(
            CoreKit.CalendarRow(CalendarKotlin.accountRow()),
            CoreKit.CalendarRow(
                id: "g1", name: "Family", color: "#0B8043", hidden: false, notify: true, group: .account,
                systemKey: nil, isDefault: false, canRename: true, canDelete: false, accountId: "m1", readOnly: true,
                remoteName: "Rodina", remoteColor: "#16A765", usesRemoteColor: true
            )
        )
    }

    func testListActionsMapEveryCase() throws {
        typealias Model = SharedCalendarListScreenModel
        XCTAssertTrue(Model.action(.retry) is SharedSDK.CalendarListActionRetry)
        XCTAssertTrue(Model.action(.refresh) is SharedSDK.CalendarListActionRefresh)
        XCTAssertEqual(
            (
                Model.change(.useRemoteColor(calendarId: "g")) as? SharedSDK.CalendarListActionChangeUseRemoteColor
            )?.calendarId, "g"
        )
        XCTAssertEqual(
            (
                Model.action(.change(.toggleHidden(calendarId: "a"))) as? SharedSDK.CalendarListActionChangeToggleHidden
            )?.calendarId, "a"
        )
        XCTAssertEqual((Model.action(.setAllHidden(true)) as? SharedSDK.CalendarListActionSetAllHidden)?.hidden, true)
        XCTAssertEqual(
            (Model.action(.openDetail(calendarId: "b")) as? SharedSDK.CalendarListActionOpenDetail)?.calendarId,
            "b"
        )
        XCTAssertTrue(Model.action(.closeDetail) is SharedSDK.CalendarListActionCloseDetail)
        let rename = try XCTUnwrap(
            Model.change(.rename(calendarId: "c", name: "N")) as? SharedSDK.CalendarListActionChangeRename
        )
        XCTAssertEqual([rename.calendarId, rename.name], ["c", "N"])
        let color = try XCTUnwrap(
            Model.change(.setColor(calendarId: "d", color: "#000000")) as? SharedSDK.CalendarListActionChangeSetColor
        )
        XCTAssertEqual([color.calendarId, color.color], ["d", "#000000"])
        let notify = try XCTUnwrap(
            Model.change(.setNotify(calendarId: "e", notify: false)) as? SharedSDK.CalendarListActionChangeSetNotify
        )
        XCTAssertEqual(notify.calendarId, "e")
        XCTAssertFalse(notify.notify)
        XCTAssertEqual((Model.action(.add(name: "Trips")) as? SharedSDK.CalendarListActionAdd)?.name, "Trips")
        XCTAssertEqual(
            (
                Model.action(.requestDelete(calendarId: "f")) as? SharedSDK.CalendarListActionRequestDelete
            )?.calendarId, "f"
        )
        XCTAssertTrue(Model.action(.confirmDelete) is SharedSDK.CalendarListActionConfirmDelete)
        XCTAssertTrue(Model.action(.cancelDelete) is SharedSDK.CalendarListActionCancelDelete)
        XCTAssertTrue(Model.action(.openSleep) is SharedSDK.CalendarListActionOpenSleep)
        XCTAssertTrue(Model.action(.dismissProblem) is SharedSDK.CalendarListActionDismissProblem)
    }

    func testTheListEffectMaps() {
        XCTAssertEqual(SharedCalendarListScreenModel.effect(SharedSDK.CalendarListEffectOpenSleep.shared), .openSleep)
    }

    // MARK: - Invitations
    func testInvitationsMapEveryPhase() {
        typealias Model = SharedInvitationsScreenModel
        XCTAssertEqual(Model.state(CalendarKotlin.invitationsState(.loading)).phase, .loading)
        XCTAssertEqual(Model.state(CalendarKotlin.invitationsState(.content)).phase, .content)
        XCTAssertEqual(
            Model.state(CalendarKotlin.invitationsState(.error, failure: .notFound)).phase,
            .failure(.notFound)
        )
        XCTAssertEqual(Model.state(CalendarKotlin.invitationsState(.error)).phase, .failure(nil))
    }

    func testInvitationsMapTabsItemsAndCounts() {
        let state = SharedInvitationsScreenModel.state(CalendarKotlin.invitationsState(
            .content, tab: .answered, items: [CalendarKotlin.invitation(
                kind: .sharedCalendarNotice,
                status: .acknowledged
            )]
        ))
        XCTAssertEqual(state.tab, .answered)
        XCTAssertEqual(state.pending, 2)
        XCTAssertEqual(state.answering, "i1")
        XCTAssertTrue(state.problem)
        XCTAssertEqual(state.problemFailure, .unavailable)
        let item = state.items.first
        XCTAssertEqual(item?.kind, .sharedCalendarNotice)
        XCTAssertEqual(item?.status, .acknowledged)
        XCTAssertEqual(item?.title, "Review")
        XCTAssertEqual(item?.startsAt, "2026-10-22T11:00:00.000Z")
        XCTAssertEqual(item?.timeZone, "Europe/Prague")
        XCTAssertEqual(item?.place, "Office")
        XCTAssertEqual(item?.organizerName, "Petr")
        XCTAssertEqual(
            SharedInvitationsScreenModel.state(CalendarKotlin.invitationsState(.content)).tab, .pending
        )
    }

    func testInvitationStatusesMapOneToOne() {
        let statuses: [SharedSDK.InvitationItemStatus] = [
            .pending, .accepted, .tentative, .declined, .acknowledged, .cancelled
        ]
        XCTAssertEqual(
            statuses.map { CoreKit.InvitationItemStatus($0) },
            [.pending, .accepted, .tentative, .declined, .acknowledged, .cancelled]
        )
        XCTAssertEqual(CoreKit.InvitationItemKind(.invite), .invite)
    }

    func testInvitationActionsMapEveryCase() throws {
        typealias Model = SharedInvitationsScreenModel
        XCTAssertTrue(Model.action(.retry) is SharedSDK.InvitationsActionRetry)
        XCTAssertEqual((Model.action(.showTab(.answered)) as? SharedSDK.InvitationsActionShowTab)?.tab, .answered)
        XCTAssertEqual((Model.action(.showTab(.pending)) as? SharedSDK.InvitationsActionShowTab)?.tab, .pending)
        XCTAssertTrue(Model.action(.dismissProblem) is SharedSDK.InvitationsActionDismissProblem)
        let replies: [(CoreKit.InvitationReply, SharedSDK.InvitationReply)] = [
            (.accept, .accept), (.tentative, .tentative), (.decline, .decline), (.acknowledge, .acknowledge)
        ]
        for (reply, expected) in replies {
            let answer = try XCTUnwrap(
                Model.action(.answer(invitationId: "i1", reply: reply)) as? SharedSDK.InvitationsActionAnswer
            )
            XCTAssertEqual(answer.invitationId, "i1")
            XCTAssertEqual(answer.reply, expected)
        }
    }

    // MARK: - New item
    func testNewItemMapsEveryPhase() {
        typealias Model = SharedNewItemScreenModel
        XCTAssertEqual(Model.state(CalendarKotlin.newItemState(.loading)).phase, .loading)
        XCTAssertEqual(Model.state(CalendarKotlin.newItemState(.editing)).phase, .editing)
        XCTAssertEqual(Model.state(CalendarKotlin.newItemState(.saving)).phase, .saving)
        XCTAssertEqual(Model.state(CalendarKotlin.newItemState(.failed, failure: .rejected)).phase, .failed(.rejected))
        XCTAssertEqual(Model.state(CalendarKotlin.newItemState(.failed)).phase, .failed(nil))
    }

    func testNewItemMapsTheGroupsTheirAccountsEveryQualifierAndTheDay() {
        let state = SharedNewItemScreenModel.state(CalendarKotlin.newItemState(.editing))
        let icloud = CoreKit.NewItemAccount(id: "m1", name: "iCloud", address: "david@tresnak.cc")
        XCTAssertEqual(
            state.groups,
            [
                CoreKit.NewItemCalendarGroup(
                    calendars: [
                        CoreKit.NewItemCalendar(
                            id: "c1", name: "Osobní", color: "#007AFF", isDefault: true, qualifier: .own
                        )
                    ]
                ),
                CoreKit.NewItemCalendarGroup(
                    account: icloud,
                    calendars: [
                        CoreKit.NewItemCalendar(
                            id: "g1", name: "Osobní", color: "#0B8043", account: icloud, qualifier: .accountName
                        ),
                        CoreKit.NewItemCalendar(
                            id: "g2", name: "Rodina", color: "#16A765", account: icloud, qualifier: .accountAddress
                        ),
                        CoreKit.NewItemCalendar(
                            id: "g3", name: "Work", color: "#16A765", account: icloud, qualifier: .unqualified
                        )
                    ]
                ),
                CoreKit.NewItemCalendarGroup(account: CoreKit.NewItemAccount(id: ""), calendars: [])
            ]
        )
        XCTAssertEqual(state.calendars.map(\.id), ["c1", "g1", "g2", "g3"])
        XCTAssertEqual(state.defaultDay, "2026-10-17")
    }

    func testNewItemActionsAndEffectMap() throws {
        typealias Model = SharedNewItemScreenModel
        XCTAssertTrue(Model.action(.edited) is SharedSDK.NewItemActionEdited)
        let draft = NewItemDraft(
            kind: .task, title: "Pay", day: "2026-10-17", timed: true, startMinutes: 840, hasEnd: true, endMinutes: 900,
            place: "x", calendarId: "c1"
        )
        let create = try XCTUnwrap(Model.action(.create(draft)) as? SharedSDK.NewItemActionCreate)
        XCTAssertEqual(create.kind, .task)
        XCTAssertEqual([create.title, create.day, create.place, create.calendarId], ["Pay", "2026-10-17", "x", "c1"])
        XCTAssertEqual([create.startMinutes, create.endMinutes], [840, 900])
        XCTAssertTrue(create.timed)
        XCTAssertTrue(create.hasEnd)
        let event = try XCTUnwrap(
            Model.action(.create(NewItemDraft(
                kind: .event, title: "T", day: "d", timed: false, startMinutes: 0, hasEnd: false,
                endMinutes: 0, place: "", calendarId: ""
            ))) as? SharedSDK.NewItemActionCreate
        )
        XCTAssertEqual(event.kind, .event)
        XCTAssertNil(event.alertMinutes)
        XCTAssertNil(event.travelMinutes)
        XCTAssertEqual(event.repeat, .never)
        XCTAssertEqual(Model.effect(SharedSDK.NewItemEffectCreated(itemId: "new1")), .created(itemId: "new1"))
    }

    func testNewItemOptionsMap() throws {
        typealias Model = SharedNewItemScreenModel
        let draft = NewItemDraft(
            kind: .event, title: "Trip", day: "2026-10-17", timed: true, startMinutes: 600, hasEnd: true,
            endMinutes: 540, place: "", calendarId: "", endDay: "2026-10-19", notes: "Map", url: "https://x.cz",
            alertMinutes: 25, travelMinutes: 45, repeatRule: .weekly, flagged: true
        )
        let create = try XCTUnwrap(Model.action(.create(draft)) as? SharedSDK.NewItemActionCreate)
        XCTAssertEqual([create.endDay, create.notes, create.url], ["2026-10-19", "Map", "https://x.cz"])
        XCTAssertEqual(create.alertMinutes?.intValue, 25)
        XCTAssertEqual(create.travelMinutes?.intValue, 45)
        XCTAssertTrue(create.flagged)
        let repeats: [(CoreKit.NewItemRepeat, SharedSDK.NewItemRepeat)] = [
            (.never, .never), (.daily, .daily), (.weekdays, .weekdays), (.weekly, .weekly), (.monthly, .monthly),
            (.yearly, .yearly)
        ]
        for (swift, kotlin) in repeats {
            XCTAssertEqual(swift.shared, kotlin)
        }
    }
}
