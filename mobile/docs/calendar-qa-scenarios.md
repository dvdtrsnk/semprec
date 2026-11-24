# Calendar screen: manual QA scenarios

Every scenario is run by hand on an iOS Simulator (iPhone 18 Pro, never the iPhone Duo) next to the system Calendar app
on the same simulator, with equivalent data. The expected result is what the system Calendar does; a difference that is
not a deliberate Semprec feature is a defect. Results of each run are kept in `calendar-qa-results.md`.

## How a scenario is run

- Preconditions: a simulator with a build of the app signed ad hoc (`CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES`),
  so that the session survives a relaunch, and signed in to a throwaway backend that holds only test data.
- The same events are put into the system Calendar as a subscription to an `.ics` file (`webcal://` URL), plus events
  created by hand there when editing has to be compared (long press, handles, delete).
- Input: tap, long press (hold of at least 0.35 s without moving), long press then drag (a slow swipe), swipes, typing.
  A pinch cannot be sent through the Device Lab input tools and is marked BLOCKED.
- After every meaningful step a screenshot is taken and read. A scenario is PASS only when it was performed and the
  result looked at; otherwise it is FAIL or BLOCKED with the reason.

## Datasets

| Name | Day | Content |
|------|-----|---------|
| today | the current day | an event around now, an overlapping one, a reminder, an evening event, an all-day event |
| overlaps | Wed 25 Nov 2026 | 3 events in one slot; a chain 11:00-12:00, 11:45-12:45, 12:30-13:30; 14:00-18:00 with 14:30-15:30, 15:00-16:00 and 15:15-15:30 inside; three back to back |
| boundaries | Thu 26 Nov 2026 | 00:00-00:30; 5 min and 1 min events; one without an end; 15 and 30 min; 23:00-00:30 next day; 22:00-23:59; 00:00-23:59 |
| all-day | Fri 27 Nov 2026 | one, long title, a birthday, a 4-day trip, a conference over 26-28 Nov, plus a timed event |
| reminders | Sat 28 Nov 2026 | reminders with and without a time, four at the same time, a flagged one, ones at an event's start, inside it and at its end, and 6 all-day events |
| titles | Sun 29 Nov 2026 | very long title and place, diacritics, emoji, right-to-left, one character, multi-line, markup, a long title in a 15 min slot |
| dense | Mon 30 Nov 2026 | 2 events and a reminder every hour from 06:00 to 22:00 |
| repeating | the current day onward | a daily stand-up, a weekly and a monthly event |
| far | 2020, 2028, 2030, New Year, DST | far days, a leap day, midnight of the new year, the day the clock changes in March 2027 |
| probes | 1-4 Dec 2026 | pairs of 1 h events that start 0, 10, 20, 30, 40, 50 and 59 minutes apart, staircases and nested triples |


## A. Timeline layout of timed events

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| A01 | one event 1 h, alone | full width, bar + title + time (obs) |
| A02 | two events identical slot | two equal columns (obs) |
| A03 | three events identical slot | three equal columns (obs) |
| A04 | four events identical slot | four equal columns, titles truncated (exp) |
| A05 | five events identical slot | five columns, narrow, title still starts (exp) |
| A06 | eight events identical slot | very narrow columns, no crash, tappable (exp) |
| A07 | B starts +10 min after A (both 1 h) | two columns (obs) |
| A08 | B starts +20 min | two columns (obs) |
| A09 | B starts +30 min | two columns (obs) |
| A10 | B starts +40 min | cascade: B indented ~11 pt over A, full width (obs) |
| A11 | B starts +50 min | cascade (obs) |
| A12 | B starts +59 min | cascade (obs) |
| A13 | chain A 11:00-12:00, B 11:45-12:45, C 12:30-13:30 | each step indented further (obs) |
| A14 | nested: long 14-18, inside 14:30-15:30, 15:00-16:00, 15:15-15:30 | 2 columns + indent (obs) |
| A15 | staircase +20/+40 (A, B+20, C+40) | A/B columns, C cascades under rule (exp) |
| A16 | long event with two sequential events inside (09-12 with 09-10, 10-11) | inner ones share column, later cascades? (exp) |
| A17 | three events where two overlap each other and a long one (P, Q long, R+30) | three columns (obs) |
| A18 | events that only touch (10-11, 11-12) | no overlap, full width each (exp) |
| A19 | event ends 23:59 | block to bottom of day (obs) |
| A20 | event 00:00-00:30 at top of day | not clipped by header (obs) |
| A21 | event 00:00-24:00 whole day | spans entire timeline (obs) |
| A22 | 5-minute event | thin strip, title only, real time kept (obs) |
| A23 | 1-minute event | thin strip (obs) |
| A24 | 0-length event (start == end) | thin strip (exp) |
| A25 | event without end | default length block (obs) |
| A26 | 15-minute event | title only, one line (obs) |
| A27 | 30-minute event | title only (obs "Starts at midnight") |
| A28 | 45-minute event | title + time (exp) |
| A29 | two short events 10 min apart | side by side, no visual overlap (exp) |
| A30 | two short events 30 min apart | stacked, no overlap |
| A31 | timed event crossing midnight, first day | block 23:00 to bottom (obs) |
| A32 | timed event crossing midnight, second day | block from 00:00 to end (exp) |
| A33 | timed event longer than 24 h | all-day row both days (exp) |
| A34 | multi-day timed event 3 days | all-day row on each (exp) |
| A35 | label for a split event (first day) | start only (obs) |
| A36 | event with place | place line on 2nd/3rd line only when tall enough (exp) |
| A37 | event with very long title in 1 h block | wraps to 2 lines max, ellipsis (obs) |
| A38 | title with newline | shown on one line (exp) |
| A39 | event tentative | dashed/striped look (exp) |
| A40 | event declined | struck-through or hidden (exp) |
| A41 | events from several calendars | each calendar colour bar + tint (obs) |
| A42 | cascade z-order | later event above earlier one (obs) |
| A43 | cascade under selection | selected event comes to front, full width (obs) |
| A44 | events across two overlapping clusters separated by a gap | independent column counts (exp) |
| A45 | cluster with 12 events over the whole day | layout finishes quickly (perf) |
| A46 | block text colour contrast on tint (light mode) | readable (obs) |
| A47 | block text colour contrast on tint (dark mode) | readable (exp) |
| A48 | hour labels zero padded in 24 h region ("07:00") | obs |
| A49 | hour label under the "now" capsule is hidden | exp |
| A50 | end of day line "00:00" at bottom with extra blank space below | obs |
| A51 | first hour line at top aligns under header, not hidden | OPEN |
| A52 | timeline starts scrolled to ~2 h before now (today) | exp |
| A53 | timeline of other days starts at 07:00 vs Apple keeping the previous scroll offset | obs |
| A54 | swiping between days keeps vertical scroll offset | Apple yes |
| A55 | scroll position kept when returning from detail/new item | exp |
| A56 | scroll to top bounce, scroll to bottom bounce | exp |
| A57 | pinch zoom in/out limits | exp |
| A58 | pinch zoom keeps the time under the fingers | exp |
| A59 | hour height persists across launches | OPEN |
| A60 | two-finger vertical pinch only when fingers stacked (user preference) | OPEN |

## B. All-day area

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| B01 | no all-day events | row hidden (obs) |
| B02 | one all-day event | chip with calendar icon, full width (obs) |
| B03 | two all-day events | two-column grid (obs) |
| B04 | six all-day events | grid capped in height, inner scroll (obs) |
| B05 | twenty all-day events | header never pushes the timeline out of the screen |
| B06 | label "all-day" hyphenated, left aligned (obs) | FIXED (row hidden when empty, "all-day") |
| B07 | multi-day all-day (Conference 26-28) shown on each day (obs) | OPEN |
| B08 | multi-day chip continues visually (arrow/edge) (exp) | OPEN |
| B09 | all-day with long title | ellipsis (obs) |
| B10 | birthday all-day | gift icon (obs) |
| B11 | holiday all-day | icon, subscribed calendar colour (obs "Den boje") |
| B12 | all-day reminder (task without time) | checkbox chip (exp) |
| B13 | tap on all-day chip | opens details (exp) |
| B14 | long press on all-day chip | menu (exp) |
| B15 | drag all-day chip into timeline | gives it a time (Semprec feature) |
| B16 | drag timed event up into all-day row | becomes all-day |
| B17 | all-day row scroll when more than visible rows | OPEN |
| B18 | all-day row with sleep marker | OPEN |
| B19 | all-day area height animates when items appear/disappear | exp |
| B20 | header divider under all-day area | obs |

## C. Reminders / tasks in the calendar

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| C01 | reminder with time | small chip with checkbox, title, time (exp) |
| C02 | reminder without time | all-day area chip (exp) |
| C03 | two reminders same minute | stacked/side by side, readable titles |
| C04 | three reminders same minute | OPEN |
| C05 | reminder + event same time | OPEN |
| C06 | reminder inside an event | shown as event sub-task (Semprec) |
| C07 | reminder at event start | OPEN |
| C08 | reminder at event end | OPEN |
| C09 | reminder at 00:05 over sleep alarm label | no text collision |
| C10 | reminder at 23:45 near bottom | fits above end |
| C11 | tick checkbox | haptic, strikethrough animation, stays or fades |
| C12 | untick | OPEN |
| C13 | tick all-day reminder | OPEN |
| C14 | tick missed reminder | OPEN |
| C15 | flagged reminder | flag indicator |
| C16 | reminder long title | OPEN |
| C17 | reminder with repeat | each occurrence |
| C18 | reminder drag to another time | snaps 15 min |
| C19 | reminder drag onto an event | becomes sub-task (Semprec) |
| C20 | reminder delete via menu | OPEN |
| C21 | reminder duplicate via menu | OPEN |
| C22 | reminder cut/paste | OPEN |
| C23 | overdue reminders on past days | ghost style |
| C24 | completed reminders shown/hidden | Apple "Show Completed Reminders" |
| C25 | reminder column width when beside events | not wasting a full column |

## D. Header, week strip, day pager

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| D01 | week strip Monday-first, weekday letters (obs M T W…) vs Semprec "Mon Tue" | DIFF(minor) |
| D02 | selected day capsule colour: black (Apple) vs accent | DIFF(design) |
| D03 | today marker colour: red (Apple) vs gold (Semprec) | design, keep |
| D04 | weekend days dimmed | obs |
| D05 | tap on a day | haptic + immediate selection |
| D06 | swipe week strip | moves a week, keeps weekday |
| D07 | swipe timeline left/right | day changes, haptic at decision |
| D08 | swipe velocity: fast flick passes one day only | OPEN |
| D09 | swipe during vertical scroll inertia | no accidental day change |
| D10 | date title format "Thursday – 26. 11. 2026" vs "Thursday 26 November" | design, keep |
| D11 | week number "W48" at the start of the date line | Semprec feature |
| D12 | back button label (month name) | obs |
| D13 | back button transforms to year when in month | OPEN |
| D14 | Today button: haptic, scroll to now, selects today | OPEN |
| D15 | Today while already on today | scrolls to now |
| D16 | Today from a far month | OPEN |
| D17 | header glass blur over scrolling items | user preference |
| D18 | header in dark mode | user preference |
| D19 | header height stable with 0/1/6 all-day items | OPEN |
| D20 | header under status bar with notch/dynamic island | OPEN |
| D21 | week strip when week spans two months | OPEN |
| D22 | week strip year boundary (Dec 28 – Jan 3) | OPEN |
| D23 | ISO week number at year boundary (W53 / W1) | OPEN |
| D24 | tap on week number | nothing (exp) |
| D25 | day pager edge: far past (2020) and far future (2030) | OPEN |

## E. Gestures on items

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| E01 | tap event | opens details (obs/exp) |
| E02 | tap background while an item is selected | deselect |
| E03 | tap another item while one is selected | deselect only |
| E04 | long press 0.35 s | selection + haptic + menu |
| E05 | long press on cascaded event | selects the touched one |
| E06 | long press then drag | move with snap 15 min, preview block, haptic on each snap |
| E07 | move preview shows new time live | OPEN |
| E08 | move across midnight/day edge | clamped to day |
| E09 | move to another day | Semprec: drag to week strip? |
| E10 | auto-scroll when dragging near top/bottom edge | OPEN |
| E11 | drag released outside any area | cancel or commit? |
| E12 | drag cancelled by system (incoming interrupt) | OPEN |
| E13 | resize top handle | min 15 min, live label |
| E14 | resize bottom handle | OPEN |
| E15 | resize handle reachable when event is under floating bars | OPEN |
| E16 | resize past 00:00/24:00 | clamped |
| E17 | handle visual: circles top-right / bottom-left (Apple) vs Semprec | DIFF |
| E18 | selected style: solid accent fill + white text (Apple) vs outline | FIXED (solid accent, full width) |
| E19 | selected event on top of cascade, full width (obs) | FIXED (solid accent, full width) |
| E20 | haptics: selection on long press (Apple) | OPEN |
| E21 | haptics: snap while dragging | OPEN |
| E22 | double tap | nothing/zoom? |
| E23 | long press on empty space | new event at that time or paste (Semprec: paste) |
| E24 | long press on empty space with clipboard | paste at position |
| E25 | swipe inside selected event | no day change while selected |
| E26 | scroll while an item is selected | menu follows or hides |
| E27 | rotate/ background app while selected | selection cleared |
| E28 | gesture on read-only event (subscribed calendar) | select not allowed, tap opens |
| E29 | gesture on holiday/birthday | tap shows, no edit |
| E30 | gesture while a write is in flight (busy) | ignored, no stuck state |

## F. Edit menu (Cut / Copy / Delete / Duplicate)

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| F01 | menu style: horizontal capsule below the event (obs) vs vertical popover above | FIXED (capsule below item, order Cut/Copy/Delete/Duplicate) |
| F02 | menu order Cut | Copy | Delete | Duplicate (obs) vs Cut/Copy/Duplicate/Delete | FIXED (capsule below item, order Cut/Copy/Delete/Duplicate) |
| F03 | menu appears with fade+scale animation from the item | OPEN |
| F04 | menu never covers the item itself | OPEN |
| F05 | menu never goes off-screen top/bottom/left/right | OPEN |
| F06 | menu near the bottom edge flips above the event | OPEN |
| F07 | menu for event at far left/right of narrow column | arrow/capsule clamped inside screen |
| F08 | menu when item is partly scrolled out of view | OPEN |
| F09 | menu dismisses on tap outside, item deselects | OPEN |
| F10 | menu dismisses on scroll start | OPEN |
| F11 | menu dismisses on swipe day | OPEN |
| F12 | menu for reminders: Delete/Duplicate/... same | OPEN |
| F13 | menu entries disabled for read-only | OPEN |
| F14 | menu accessibility labels + identifiers | OPEN |
| F15 | menu in dark mode | OPEN |
| F16 | menu with Dynamic Type XL | OPEN |
| F17 | menu with Reduce Motion | no scale animation |
| F18 | copy then paste via long press on empty space | OPEN |
| F19 | cut then paste moves the event | OPEN |
| F20 | duplicate creates a copy at the same time (Apple: same slot) | OPEN |
| F21 | clipboard banner/indicator | Semprec shows in bottom bar? |
| F22 | cut item shows ghost until pasted | OPEN |
| F23 | paste in another day | OPEN |
| F24 | paste into the all-day row | OPEN |

## G. Delete

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| G01 | delete via menu | Apple deletes immediately, no alert (obs) vs confirm alert |
| G02 | deleted block animates out (scale/fade) | OPEN |
| G03 | delete last event of day | OPEN |
| G04 | delete event with sub-tasks | tasks stay (message) |
| G05 | delete recurring occurrence | "this/all" choice (Apple) |
| G06 | delete from details screen | OPEN |
| G07 | delete read-only event | not offered |
| G08 | delete failure (offline) | error alert and item reappears |
| G09 | delete while editing elsewhere | OPEN |
| G10 | delete 20 events in a row | OPEN |
| G11 | undo after delete (shake) | Apple yes |
| G12 | deleted event removed from month dots and agenda | OPEN |
| G13 | deleted all-day event | header shrinks with animation |
| G14 | delete reminder | OPEN |
| G15 | delete then immediately create same title | OPEN |

## H. Creating events

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| H01 | + button opens sheet with animation, title field not auto-focused (obs Apple) | DIFF(minor) |
| H02 | default day = selected day | OPEN |
| H03 | default start time: Apple = current hour on other days / next hour today | DIFF(minor) |
| H04 | default duration 1 h | OPEN |
| H05 | empty title | save disabled (obs) |
| H06 | whitespace-only title | save disabled |
| H07 | very long title (300 chars) | OPEN |
| H08 | emoji/RTL title | OPEN |
| H09 | date row expands to Starts/Ends/All-day/Repeat on tap (obs) | PASS |
| H10 | starts after ends | end auto-adjusts |
| H11 | change start moves end (keeps duration) | OPEN |
| H12 | all-day toggle hides times | OPEN |
| H13 | multi-day all-day | OPEN |
| H14 | end on next day (crossing midnight) | OPEN |
| H15 | repeat daily/weekdays/weekly/monthly (yearly not for events) | OPEN |
| H16 | repeat end | Apple has "End repeat" |
| H17 | alert options list | OPEN |
| H18 | travel time options | OPEN |
| H19 | location text field | OPEN |
| H20 | calendar chooser list with colours | OPEN |
| H21 | calendar chooser lists only editable calendars | OPEN |
| H22 | notes multiline | OPEN |
| H23 | URL validation | OPEN |
| H24 | attachment (Apple has) | not in Semprec |
| H25 | Event/Task switch keeps title | OPEN |
| H26 | task form: due date/time optional, flag, repeat | OPEN |
| H27 | task without date | goes to inbox |
| H28 | cancel with changes | Apple asks discard |
| H29 | cancel without changes | closes at once |
| H30 | swipe down to dismiss with changes | confirmation |
| H31 | keyboard avoidance | focused field visible |
| H32 | save success | sheet closes, new event appears with animation, scrolled into view |
| H33 | save when the new event is off-screen | timeline scrolls to it |
| H34 | save offline | queued, shown, syncs later |
| H35 | save server error | message, sheet stays |
| H36 | double tap on save | one event only (idempotency) |
| H37 | create 30 events in a row | all show up |
| H38 | create event overlapping existing | layout recomputed |
| H39 | create in far future/past | OPEN |
| H40 | create with title only containing digits | OPEN |
| H41 | time picker snap/step | OPEN |
| H42 | picker in 12 h region | OPEN |
| H43 | Czech localisation of the whole sheet | OPEN |
| H44 | sheet in dark mode | OPEN |
| H45 | sheet with Dynamic Type XXL | OPEN |

## I. Month view

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| I01 | month title large, weekday letters header | obs |
| I02 | content of a day cell in the month view | the system Calendar shows titled chips and "+N"; Semprec keeps, by the owner's decision, one line made of the colours of the day's events, as long as they last |
| I03 | today marker | OPEN |
| I04 | selected day marker | OPEN |
| I05 | busy day (13 events) | overflow indicator |
| I06 | all-day events visible in cell | OPEN |
| I07 | scroll month smoothly vertically (user preference) | OPEN |
| I08 | month header changes while scrolling | OPEN |
| I09 | tap day opens day view with transition | OPEN |
| I10 | tap on empty cell | opens day |
| I11 | long press on a day | new event? (Apple no) |
| I12 | first week partial row styling | OPEN |
| I13 | month with 6 rows | OPEN |
| I14 | month boundary labels (short month name above 1st) | obs "Dec" |
| I15 | recurring daily event shown in every cell as dot | OPEN |
| I16 | month in dark mode | OPEN |
| I17 | weekend dimming | PASS |
| I18 | scroll far (±12 months) re-anchors without jump | OPEN |
| I19 | back to year view | OPEN |
| I20 | Today button in month | scrolls to current month |
| I21 | events created while in month view appear | OPEN |
| I22 | month view with sleep/semp markers | OPEN |

## J. Year view

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| J01 | 12 mini months, today highlighted | obs |
| J02 | swipe/scroll to previous/next year smoothly | OPEN |
| J03 | tap a month | zoom transition |
| J04 | current month label colour | OPEN |
| J05 | back button absent in year | OPEN |
| J06 | Today in year | goes to current month? |
| J07 | year 2030 / 2020 | OPEN |
| J08 | mini month weekend dimming | OPEN |
| J09 | year view dark mode | OPEN |
| J10 | search button (Apple) | Semprec none |

## K. Zoom transitions (year ↔ month ↔ day)

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| K01 | year → month animation (shared element) | OPEN |
| K02 | month → day animation | OPEN |
| K03 | day → month back button | OPEN |
| K04 | month → year back | OPEN |
| K05 | interrupted transition (tap back during animation) | no glitch |
| K06 | transition with Reduce Motion | OPEN |
| K07 | transition frame rate (no hitch) | OPEN |
| K08 | back-button label crossfade/blur | OPEN |
| K09 | swipe-back edge gesture | OPEN |
| K10 | transitions after data change | OPEN |

## L. Calendars list screen

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| L01 | list of calendars grouped by account (obs Apple: On My iPhone / Subscribed / Other) | OPEN |
| L02 | toggle visibility | events appear/disappear with animation |
| L03 | colour of calendar edit | OPEN |
| L04 | rename calendar | OPEN |
| L05 | create calendar | OPEN |
| L06 | delete calendar | impact message |
| L07 | hidden calendar hides its events in day/month | OPEN |
| L08 | subscribed read-only calendar | OPEN |
| L09 | internet account calendars (iCloud/Google) | OPEN |
| L10 | calendar with 0 events | OPEN |
| L11 | default calendar choice | OPEN |
| L12 | invitation inbox button + badge | OPEN |
| L13 | sheet presentation style (Apple sheet with X) | OPEN |
| L14 | calendar names with emoji/long names | OPEN |
| L15 | many calendars (30) | scroll |

## M. Invitations

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| M01 | inbox empty state | OPEN |
| M02 | accept/decline/maybe | OPEN |
| M03 | invitation for an overlapping time | warning? |
| M04 | badge count on the button | OPEN |

## N. Agenda (list) view

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| N01 | list grouped by day, sticky day headers | OPEN |
| N02 | empty day | OPEN |
| N03 | all-day events listed first | OPEN |
| N04 | reminders listed | OPEN |
| N05 | tap row | details |
| N06 | swipe row actions | OPEN |
| N07 | scroll infinite both directions | OPEN |
| N08 | today pinned/jump | OPEN |
| N09 | row time format | OPEN |
| N10 | multi-day event repeated each day | OPEN |
| N11 | long titles/place | OPEN |
| N12 | agenda dark mode | OPEN |

## O. Time, locale, timezone

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| O01 | 24 h region format zero padded | FIXED (locale clock, verified "07:00") |
| O02 | 12 h region (en_US) labels "9 AM" | OPEN |
| O03 | first weekday Monday vs Sunday region | OPEN |
| O04 | DST spring forward day (2027-03-28 02:00 missing hour) | OPEN |
| O05 | DST autumn day (2026-10-25 duplicated hour) | OPEN |
| O06 | event 02:30 on DST gap day | OPEN |
| O07 | device timezone different from server zone | now line and events agree |
| O08 | midnight rollover while screen open | today changes |
| O09 | app resumed next day | Today updated |
| O10 | leap day 29 Feb 2028 | OPEN |
| O11 | year boundary | OPEN |
| O12 | now line moves every minute | OPEN |
| O13 | now line only on today | OPEN |
| O14 | now capsule overlaps hour label | label hidden |
| O15 | Czech vs English UI language switch | OPEN |

## P. Data robustness

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| P01 | empty title event | shown as "(untitled)"? |
| P02 | title with only emoji | OPEN |
| P03 | title RTL | OPEN |
| P04 | title with markdown/html | shown literally |
| P05 | 100 events on one day | scroll smooth |
| P06 | 1000 events in a month | month view fast |
| P07 | event far outside window (2100) | OPEN |
| P08 | server returns event with end before start | OPEN |
| P09 | server unreachable at launch | error state + retry |
| P10 | server comes back | auto refresh |
| P11 | realtime update from other device | OPEN |
| P12 | session expired mid-use | sign-in prompt |
| P13 | slow network | spinners, no frozen UI |
| P14 | duplicate event ids | OPEN |
| P15 | event with attendees | indicator |

## Q. Appearance and accessibility

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| Q01 | dark mode whole screen | OPEN |
| Q02 | dark mode header glass (black translucent, no gloss) | user preference |
| Q03 | Dynamic Type small/large/XXL/AX5 | blocks, header, menu |
| Q04 | bold text | OPEN |
| Q05 | increase contrast | OPEN |
| Q06 | reduce transparency | header still readable |
| Q07 | reduce motion | transitions simplified |
| Q08 | VoiceOver reads event "title, time, place" | OPEN |
| Q09 | VoiceOver actions: delete/duplicate | OPEN |
| Q10 | VoiceOver order of header → all-day → timeline | OPEN |
| Q11 | Switch Control / keyboard navigation | OPEN |
| Q12 | landscape iPhone | layout usable, nothing off-screen |
| Q13 | iPad portrait/landscape split view | OPEN |
| Q14 | smallest iPhone (SE) | nothing clipped |
| Q15 | largest iPhone | OPEN |
| Q16 | safe areas, home indicator vs floating bars | OPEN |
| Q17 | floating bottom bars cover the last hours | scroll inset so last hour reachable |
| Q18 | colour-blind calendar colours distinguishable | OPEN |
| Q19 | Left-to-right/right-to-left layout (Arabic region) | OPEN |
| Q20 | larger text in the week strip does not clip | OPEN |

## R. Stability and performance

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| R01 | open calendar cold | time to content |
| R02 | swipe 30 days quickly | no hitches, memory stable |
| R03 | pinch zoom 5 s | frame rate |
| R04 | long press/drag/drop loop 50× | no leaks, no stuck state |
| R05 | background → foreground | refresh |
| R06 | memory warning | OPEN |
| R07 | rapid create+delete | OPEN |
| R08 | rotate during menu | OPEN |
| R09 | system alert during drag | OPEN |
| R10 | app kill during pending write | recovered |

## S. Semprec-specific timeline items

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| S01 | sleep band evening/morning drawing | OPEN |
| S02 | sleep prep marker overlapping event text | FIXED? (label hidden when covered) |
| S03 | sleep band colour vs events | OPEN |
| S04 | tap on sleep band | opens sleep |
| S05 | semp target (long press to ask Semp) | OPEN |
| S06 | haze/paper background scroll | OPEN |
| S07 | floating Semp button over the sheet | OPEN |
| S08 | week number | OPEN |
| S09 | carried-over task traces | OPEN |
| S10 | missed tasks inside events | OPEN |

## T. Navigation, haptics and header details

| ID | Scenario | Native iOS Calendar (reference) |
|----|----------|---------------------------------|
| T01 | tap a day in the week strip | the selected day changes in the strip at once, the timeline slides to it, one selection haptic |
| T02 | swipe the week strip to the next week | the same weekday of the next week is selected, no haptic for the week turn |
| T03 | swipe the timeline to the next day | the strip marks the new day the moment the swipe is decided, one haptic |
| T04 | Today in the day view on another day | soft impact, the timeline returns to the current time |
| T05 | Today in the month view | goes to today's day view (used to reach the day view) |
| T06 | Today in the year view | goes into this month |
| T07 | back button day -> month | the label turns from the month to the year while the view zooms out |
| T08 | back button month -> year | the label vanishes, the year view appears |
| T09 | pinch with fingers above each other on the timeline | the hour height changes between 32 and 112 pt, the time under the fingers stays |
| T10 | pinch with fingers side by side | nothing happens |
| T11 | header glass over coloured events, light mode | blurred colours of what scrolls under it, no shapes recognisable |
| T12 | header glass over coloured events, dark mode | black translucent, no glossy rim |
| T13 | separator below the all-day area | one hairline (1.5 px) that ends the header background |
| T14 | month view, swipe sideways | nothing moves, the month only scrolls vertically |
| T15 | month view, slow vertical scroll | smooth, the large title follows the month at the top |
| T16 | year view, vertical scroll | smooth, no paging |
| T17 | long press on an empty place of the timeline | the system Calendar starts a new event at that time; Semprec pastes when something is cut or copied |
| T18 | tap on an empty place of the timeline | nothing, a held item is deselected |
| T19 | double tap on the timeline | nothing |
| T20 | keyboard open in the new item sheet, then save | the keyboard goes down with the sheet, the new item shows at once |
