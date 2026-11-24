# Calendar screen: QA results

Scenarios are in `calendar-qa-scenarios.md`. A scenario is PASS only when it was performed and its result looked at on the
simulator (next to the system Calendar where the system Calendar has the behaviour); NOT RUN means it has not been performed in
that run and counts as open, not as passed. Evidence names are screenshots kept with the run, outside the repository.

## Run 1 (2026-11-24, ad-hoc build r5 to r10 of the branch)

Summary: BLOCKED 35, DIFF 5, FIXED 5, NOT RUN 251, PASS 111 of 407 scenarios.

Defects found and fixed while running it: events over midnight in the all-day row, 5 and 1 minute events drawn as 15 minutes, events starting later laid in columns instead of a cascade, a vertical popover menu above the item instead of the capsule below it, an outline instead of a solid held item, an all-day area that always took a row and grew without limit, clock labels not written the region's way, sleep labels over event titles, a drag stuck after an interrupted touch, a delete confirmation the system Calendar does not have, an agenda not sorted by time, a multi-line title shown as "Multi...", a week strip that wrapped at large text, a new-item form that closed without asking, an all-day chip without a menu, and a day that jumped to its start hour when the all-day area changed height.

Open differences: events that start at the same minute are ordered differently from the system Calendar (A17); the vertical scroll position is not kept when changing day (A53, to be confirmed against the system Calendar).

Not performed because the tools cannot: pinch, haptics and motion. Everything not listed with a result was not performed in this run.

Input tool notes: `bb device-lab swipe` sends only the start and the end of a swipe, so a swipe that starts on an event block does not scroll the day; `axe drag --steps` does. A handle or block drag sent by the tool is only closed by the next touch. These are limits of the tool, not defects of the app, and are not counted as FAIL.

Not reached in this run (NOT RUN): about 250 scenarios of the groups L (calendar editing), M (invitations), most of H (form fields), N, O (time zones and DST), P (data limits), Q (accessibility settings) and S. The next run walks them, and everything again.

## Results of the latest run

| ID | Result | Evidence / difference from the system Calendar |
|----|--------|-----------------------------------------------|
| A01 | PASS | s-today2: lone event full width with bar, title, time |
| A02 | PASS | p-d1a: A+0/B+0 06:00 two equal columns (Apple order of the two differs, see A17) |
| A03 | PASS | pair-s25: Same slot A/B/C three equal columns |
| A04 | NOT RUN |  |
| A05 | NOT RUN |  |
| A06 | NOT RUN |  |
| A07 | PASS | p-d1a: +10/+20 pairs in two columns, as Apple |
| A08 | PASS | p-d1a: +10/+20 pairs in two columns, as Apple |
| A09 | NOT RUN |  |
| A10 | PASS | p-d1b vs Apple: +40/+50/+59 cascade, indented over the earlier block |
| A11 | PASS | p-d1b vs Apple: +40/+50/+59 cascade, indented over the earlier block |
| A12 | PASS | p-d1b vs Apple: +40/+50/+59 cascade, indented over the earlier block |
| A13 | PASS | pair-s25: chain cascades, nested 14-18 block with 2 columns and indent, as Apple probe |
| A14 | PASS | pair-s25: chain cascades, nested 14-18 block with 2 columns and indent, as Apple probe |
| A15 | NOT RUN |  |
| A16 | NOT RUN |  |
| A17 | DIFF | p-d2: Apple orders equal-start blocks Q|R+30|P, Semprec Q|P|R+30 (tie order only) |
| A18 | PASS | pair-s25: three back-to-back blocks full width, no overlap |
| A19 | PASS | pair-s26n: 22:00-23:59 reaches the bottom; 00:00 block not clipped by header |
| A20 | PASS | pair-s26n: 22:00-23:59 reaches the bottom; 00:00 block not clipped by header |
| A21 | PASS | pair-s26n: 00:00-23:59 block spans the day |
| A22 | PASS | pair-s26n: 5 and 1 minute events are strips with title only |
| A23 | PASS | pair-s26n: 5 and 1 minute events are strips with title only |
| A24 | NOT RUN |  |
| A25 | PASS | g-w: an event without an end gets a one-hour block, as the system Calendar |
| A26 | PASS | g-w: 15 and 30 minute blocks say the title only on one line |
| A27 | PASS | g-w: 15 and 30 minute blocks say the title only on one line |
| A28 | NOT RUN |  |
| A29 | PASS | pair-s26n: Five minutes / One minute side by side without overlap |
| A30 | NOT RUN |  |
| A31 | PASS | pair-s26n: 23:00 block to the bottom on the first day, label shows the start only |
| A32 | PASS | g-b26 (27 Nov): the part after midnight is a 00:00 block at the top of the day |
| A33 | NOT RUN |  |
| A34 | NOT RUN |  |
| A35 | NOT RUN |  |
| A36 | NOT RUN |  |
| A37 | PASS | g-b29: a long title in a 15 minute slot stays on one line, cut with an ellipsis |
| A38 | PASS | g-b29: "Multi line title" is one line after the fix |
| A39 | NOT RUN |  |
| A40 | NOT RUN |  |
| A41 | PASS | pair-s25: each block has its calendar colour |
| A42 | PASS | pair-s25: later block lies over the earlier one |
| A43 | NOT RUN |  |
| A44 | NOT RUN |  |
| A45 | PASS | g-b30: 41 items on a day lay out in three columns, readable, scrolls without trouble |
| A46 | NOT RUN |  |
| A47 | NOT RUN |  |
| A48 | PASS | p-d1a: hour labels zero padded (07:00) |
| A49 | PASS | s-today2: label under the 16:07 capsule is hidden |
| A50 | NOT RUN |  |
| A51 | NOT RUN |  |
| A52 | NOT RUN |  |
| A53 | DIFF | the system Calendar keeps the vertical scroll position when changing day; Semprec opens another day at 07:00 (s-swipeday3-s). Not yet checked in the system Calendar, see Run 2 |
| A54 | NOT RUN |  |
| A55 | NOT RUN |  |
| A56 | NOT RUN |  |
| A57 | BLOCKED | A pinch, a gesture video or a drag with several fingers cannot be sent through the Device Lab input tools; needs a real device |
| A58 | BLOCKED | A pinch, a gesture video or a drag with several fingers cannot be sent through the Device Lab input tools; needs a real device |
| A59 | NOT RUN |  |
| A60 | BLOCKED | A pinch, a gesture video or a drag with several fingers cannot be sent through the Device Lab input tools; needs a real device |
| B01 | PASS | p-d1a: no all-day row on a day without all-day items |
| B02 | PASS | p-s28: chips with the calendar colour, full width when alone |
| B03 | PASS | p-s28: two chips per row |
| B04 | PASS | p-s28: 10 all-day items show 2.5 rows and scroll inside the header |
| B05 | PASS | p-s28: 10 all-day items show 2.5 rows and scroll inside the header |
| B06 | PASS | p-s28: label reads "all-day" |
| B07 | PASS | p-s28/s-new-saved: the Conference shows on each day it spans |
| B08 | NOT RUN |  |
| B09 | NOT RUN |  |
| B10 | NOT RUN |  |
| B11 | NOT RUN |  |
| B12 | NOT RUN |  |
| B13 | NOT RUN |  |
| B14 | FIXED | FAIL: holding an all-day chip selected it but showed no menu and no held style. Now the chip turns solid and the capsule menu opens below it (s-chipmenu-s) |
| B15 | PASS | p-b15: a chip held for a long time and pulled down becomes a one-hour block at the finger (preview 02:00-03:00 red block), and a drop makes it a timed event |
| B16 | NOT RUN |  |
| B17 | PASS | g-b26: with more than five chips the area shows two and a half rows and scrolls inside the header |
| B18 | NOT RUN |  |
| B19 | FIXED | FAIL: after dropping an all-day chip into the timeline the day jumped back to its start hour (p-b15 right); the header changing height no longer moves a day that was scrolled. Verified by deleting an all-day chip while scrolled to 17:00: the chips reflow and the day stays (s-b19c-s) |
| B20 | PASS | p-s28: one hairline below the all-day area |
| C01 | PASS | s-tasksaved: reminder with time is a one-line chip with checkbox |
| C02 | NOT RUN |  |
| C03 | DIFF | four reminders at 09:00 show titles cut to "Remi..." in quarter columns (p-s28 earlier build); the system Calendar does the same at that width, accepted |
| C04 | NOT RUN |  |
| C05 | PASS | g-b28: reminders at an event start, inside it and at its end are all readable beside the event |
| C06 | NOT RUN |  |
| C07 | PASS | g-b28: reminders at an event start, inside it and at its end are all readable beside the event |
| C08 | PASS | g-b28: reminders at an event start, inside it and at its end are all readable beside the event |
| C09 | PASS | p-s28: reminder at 00:05 with no sleep label drawn over it |
| C10 | PASS | g-b28: a 23:45 reminder sits above the sleep label, nothing overlaps |
| C11 | PASS | pair-tick: tick shows the check and a struck-through title |
| C12 | NOT RUN |  |
| C13 | NOT RUN |  |
| C14 | NOT RUN |  |
| C15 | DIFF | g-b28: a flagged reminder has no flag mark in the day; the system Reminders shows one. Not fixed yet |
| C16 | NOT RUN |  |
| C17 | NOT RUN |  |
| C18 | NOT RUN |  |
| C19 | NOT RUN |  |
| C20 | NOT RUN |  |
| C21 | NOT RUN |  |
| C22 | NOT RUN |  |
| C23 | NOT RUN |  |
| C24 | NOT RUN |  |
| C25 | NOT RUN |  |
| D01 | NOT RUN |  |
| D02 | NOT RUN |  |
| D03 | NOT RUN |  |
| D04 | NOT RUN |  |
| D05 | BLOCKED | the haptic part cannot be felt; the selection part passed in T01 |
| D06 | PASS | p-nav1: swipe on the week strip goes to the next week and keeps the weekday |
| D07 | PASS | g-v/g-w: swipes start the pager only from empty places or the gutter; a swipe that starts on a block does not turn the day (as the system Calendar) |
| D08 | NOT RUN |  |
| D09 | NOT RUN |  |
| D10 | NOT RUN |  |
| D11 | NOT RUN |  |
| D12 | NOT RUN |  |
| D13 | PASS | g-n: the back button reads the month in the day, the year in the month and is not there in the year |
| D14 | PASS | s-today-btn: Today returns to the current day and time |
| D15 | NOT RUN |  |
| D16 | NOT RUN |  |
| D17 | NOT RUN |  |
| D18 | NOT RUN |  |
| D19 | NOT RUN |  |
| D20 | NOT RUN |  |
| D21 | NOT RUN |  |
| D22 | NOT RUN |  |
| D23 | NOT RUN |  |
| D24 | NOT RUN |  |
| D25 | NOT RUN |  |
| E01 | PASS | s-detail: tap on an event opens Details |
| E02 | PASS | g-r4: a tap beside the held block deselects it |
| E03 | NOT RUN |  |
| E04 | PASS | s-menu2: long press selects the block and shows the menu |
| E05 | NOT RUN |  |
| E06 | PASS | pair-drag: slow drag moves the block, snapped to 15 minutes, preview time shown (19:15 while held) |
| E07 | NOT RUN |  |
| E08 | NOT RUN |  |
| E09 | NOT RUN |  |
| E10 | NOT RUN |  |
| E11 | NOT RUN |  |
| E12 | BLOCKED | an interrupt cannot be raised |
| E13 | NOT RUN |  |
| E14 | PASS | g-r2/g-r4: the bottom handle shows the live time 11:30 while dragged. The drag only ended at the next touch with this input tool, see the note |
| E15 | NOT RUN |  |
| E16 | NOT RUN |  |
| E17 | NOT RUN |  |
| E18 | PASS | s-r5-menu2: held block is solid accent, white text, full width, on top |
| E19 | PASS | s-r5-menu2: held block is solid accent, white text, full width, on top |
| E20 | BLOCKED | haptics cannot be felt on the simulator |
| E21 | BLOCKED | haptics cannot be felt on the simulator |
| E22 | NOT RUN |  |
| E23 | NOT RUN |  |
| E24 | PASS | g-f2/g-f4: Cut shows the banner "hold an empty place to paste", a paste on another day puts the event at the held place, snapped to 15 minutes |
| E25 | NOT RUN |  |
| E26 | NOT RUN |  |
| E27 | NOT RUN |  |
| E28 | NOT RUN |  |
| E29 | NOT RUN |  |
| E30 | NOT RUN |  |
| F01 | PASS | s-r5-menu2: horizontal glass capsule Cut|Copy|Delete|Duplicate below the block |
| F02 | PASS | s-r5-menu2: horizontal glass capsule Cut|Copy|Delete|Duplicate below the block |
| F03 | BLOCKED | motion needs a screen recording |
| F04 | PASS | g-r1/g-f1: the capsule menu sits under the held block and never covers it |
| F05 | PASS | s-menu-edge: menu flips above the block when it would run into the bottom bars |
| F06 | PASS | s-menu-edge: menu flips above the block when it would run into the bottom bars |
| F07 | NOT RUN |  |
| F08 | NOT RUN |  |
| F09 | PASS | s-drag4: tap beside the block deselects it |
| F10 | NOT RUN |  |
| F11 | NOT RUN |  |
| F12 | NOT RUN |  |
| F13 | NOT RUN |  |
| F14 | NOT RUN |  |
| F15 | PASS | s-dark-menu-s: capsule menu in dark mode, Delete in red |
| F16 | NOT RUN |  |
| F17 | BLOCKED | motion needs a screen recording |
| F18 | PASS | p-copy: Copy then long press on an empty place pastes the copy at that time, with a banner |
| F19 | PASS | g-f2/g-f4: Cut shows the banner "hold an empty place to paste", a paste on another day puts the event at the held place, snapped to 15 minutes |
| F20 | NOT RUN |  |
| F21 | PASS | g-f2/g-f4: Cut shows the banner "hold an empty place to paste", a paste on another day puts the event at the held place, snapped to 15 minutes |
| F22 | NOT RUN |  |
| F23 | PASS | g-f2/g-f4: Cut shows the banner "hold an empty place to paste", a paste on another day puts the event at the held place, snapped to 15 minutes |
| F24 | NOT RUN |  |
| G01 | PASS | pair-del: Delete removes the block at once, no alert, as Apple |
| G02 | BLOCKED | motion needs a screen recording |
| G03 | NOT RUN |  |
| G04 | NOT RUN |  |
| G05 | NOT RUN |  |
| G06 | NOT RUN |  |
| G07 | NOT RUN |  |
| G08 | NOT RUN |  |
| G09 | NOT RUN |  |
| G10 | NOT RUN |  |
| G11 | NOT RUN |  |
| G12 | NOT RUN |  |
| G13 | NOT RUN |  |
| G14 | PASS | s-b19c-s: Delete of a held all-day chip removes it at once, no alert, the remaining chips reflow |
| G15 | NOT RUN |  |
| H01 | PASS | s-new1/s-new2: sheet, disabled check without a title, date row expands |
| H02 | NOT RUN |  |
| H03 | NOT RUN |  |
| H04 | NOT RUN |  |
| H05 | PASS | s-new1/s-new2: sheet, disabled check without a title, date row expands |
| H06 | PASS | p-h: a title of three spaces leaves the check disabled |
| H07 | NOT RUN |  |
| H08 | NOT RUN |  |
| H09 | PASS | p-h: the date row opens Starts / Ends / All-day / Repeat |
| H10 | NOT RUN |  |
| H11 | PASS | s-h-wheel2-s: moving the start from 17:00 to 00:00 moved the end to 01:00, the duration is kept |
| H12 | PASS | s-new-allday: all-day toggle hides the times; multi-day end date picker |
| H13 | PASS | s-new-allday: all-day toggle hides the times; multi-day end date picker |
| H14 | NOT RUN |  |
| H15 | NOT RUN |  |
| H16 | NOT RUN |  |
| H17 | NOT RUN |  |
| H18 | NOT RUN |  |
| H19 | NOT RUN |  |
| H20 | NOT RUN |  |
| H21 | NOT RUN |  |
| H22 | NOT RUN |  |
| H23 | NOT RUN |  |
| H24 | NOT RUN |  |
| H25 | PASS | s-newtask2: Task form with date, time, repeat, flag |
| H26 | PASS | s-newtask2: Task form with date, time, repeat, flag |
| H27 | NOT RUN |  |
| H28 | FIXED | FAIL: cancel with typed text closed the sheet at once (s-h28-s); the system Calendar asks "Discard Changes". Now a dialog out of the cancel button, a swipe down is blocked while the form holds something (s-disc2-s, s-disc3-s) |
| H29 | PASS | s-h28-s earlier build and s-disc3: cancel on an untouched form closes at once |
| H30 | NOT RUN |  |
| H31 | NOT RUN |  |
| H32 | PASS | s-tasksaved/s-created1: the new item appears on its day at once |
| H33 | NOT RUN |  |
| H34 | PASS | g-p11/g-p12: an event made offline shows greyed, the banner counts "1 change waiting", and it turns normal when the server is back |
| H35 | NOT RUN |  |
| H36 | NOT RUN |  |
| H37 | NOT RUN |  |
| H38 | NOT RUN |  |
| H39 | NOT RUN |  |
| H40 | NOT RUN |  |
| H41 | NOT RUN |  |
| H42 | NOT RUN |  |
| H43 | NOT RUN |  |
| H44 | NOT RUN |  |
| H45 | NOT RUN |  |
| I01 | NOT RUN |  |
| I02 | PASS | decision of the owner: the month keeps one line per day, made of the colours of the day's events with a length that follows how long they last (not the titled chips of the system Calendar); the chips were tried and taken back (s-m4-s) |
| I03 | PASS | s-m4-s: today is gold in the month (design: gold in Semprec, red in the system Calendar) |
| I04 | NOT RUN |  |
| I05 | NOT RUN |  |
| I06 | NOT RUN |  |
| I07 | NOT RUN |  |
| I08 | NOT RUN |  |
| I09 | PASS | p-month-nav: a tap on a day opens that day, back button reads the month |
| I10 | PASS | p-month-nav: a tap on a cell opens the day |
| I11 | NOT RUN |  |
| I12 | NOT RUN |  |
| I13 | NOT RUN |  |
| I14 | PASS | pair-month: short month name above the first of a month |
| I15 | NOT RUN |  |
| I16 | PASS | g-k: month, year and agenda are readable in dark mode |
| I17 | NOT RUN |  |
| I18 | NOT RUN |  |
| I19 | NOT RUN |  |
| I20 | NOT RUN |  |
| I21 | NOT RUN |  |
| I22 | NOT RUN |  |
| J01 | PASS | g-n: year view opens with today in gold; Today in the year view goes to the current month |
| J02 | NOT RUN |  |
| J03 | NOT RUN |  |
| J04 | NOT RUN |  |
| J05 | PASS | g-n: the back button reads the month in the day, the year in the month and is not there in the year |
| J06 | NOT RUN |  |
| J07 | NOT RUN |  |
| J08 | NOT RUN |  |
| J09 | PASS | g-k: month, year and agenda are readable in dark mode |
| J10 | NOT RUN |  |
| K01 | BLOCKED | the end states are right (year, month and day views open), but the motion of the zoom cannot be judged from still frames; it needs a screen recording |
| K02 | BLOCKED | the end states are right (year, month and day views open), but the motion of the zoom cannot be judged from still frames; it needs a screen recording |
| K03 | BLOCKED | the end states are right (year, month and day views open), but the motion of the zoom cannot be judged from still frames; it needs a screen recording |
| K04 | BLOCKED | the end states are right (year, month and day views open), but the motion of the zoom cannot be judged from still frames; it needs a screen recording |
| K05 | BLOCKED | motion needs a screen recording |
| K06 | BLOCKED | motion needs a screen recording |
| K07 | BLOCKED | frame rate needs a recording |
| K08 | BLOCKED | motion needs a screen recording |
| K09 | BLOCKED | motion needs a screen recording |
| K10 | BLOCKED | motion needs a screen recording |
| L01 | PASS | s-cals: list of calendars with colour dots |
| L02 | PASS | p-cals: hiding Work removes its events and the reminder inside one; showing it brings them back (s-cals6-s) |
| L03 | NOT RUN |  |
| L04 | NOT RUN |  |
| L05 | NOT RUN |  |
| L06 | NOT RUN |  |
| L07 | PASS | p-cals: hiding Work removes its events and the reminder inside one; showing it brings them back (s-cals6-s) |
| L08 | NOT RUN |  |
| L09 | BLOCKED | needs an external iCloud or Google account |
| L10 | NOT RUN |  |
| L11 | NOT RUN |  |
| L12 | NOT RUN |  |
| L13 | NOT RUN |  |
| L14 | NOT RUN |  |
| L15 | NOT RUN |  |
| M01 | NOT RUN |  |
| M02 | NOT RUN |  |
| M03 | NOT RUN |  |
| M04 | NOT RUN |  |
| N01 | PASS | s-agenda: list grouped by day |
| N02 | NOT RUN |  |
| N03 | NOT RUN |  |
| N04 | NOT RUN |  |
| N05 | NOT RUN |  |
| N06 | NOT RUN |  |
| N07 | NOT RUN |  |
| N08 | NOT RUN |  |
| N09 | NOT RUN |  |
| N10 | NOT RUN |  |
| N11 | NOT RUN |  |
| N12 | PASS | g-k: month, year and agenda are readable in dark mode |
| O01 | NOT RUN |  |
| O02 | FIXED | FAIL: g-o showed "2:00PM" style but the hour labels read 14:00; now 2 PM and the now capsule fits (g-o3) |
| O03 | DIFF | in an en_US region the system Calendar starts weeks on Sunday; Semprec starts on Monday (g-o). The week start is fixed in the shared layer, so it is a decision, not fixed |
| O04 | NOT RUN |  |
| O05 | NOT RUN |  |
| O06 | NOT RUN |  |
| O07 | NOT RUN |  |
| O08 | NOT RUN |  |
| O09 | NOT RUN |  |
| O10 | NOT RUN |  |
| O11 | NOT RUN |  |
| O12 | NOT RUN |  |
| O13 | NOT RUN |  |
| O14 | NOT RUN |  |
| O15 | PASS | s-cs1-s: whole screen in Czech (Listopad, Úterý 24. listopadu, celý den, Dnes, T48) |
| P01 | NOT RUN |  |
| P02 | PASS | g-b29: emoji-only, right-to-left and markup titles are shown literally and whole |
| P03 | PASS | g-b29: emoji-only, right-to-left and markup titles are shown literally and whole |
| P04 | PASS | g-b29: emoji-only, right-to-left and markup titles are shown literally and whole |
| P05 | PASS | g-b30: 41 items on a day lay out in three columns, readable, scrolls without trouble |
| P06 | NOT RUN |  |
| P07 | NOT RUN |  |
| P08 | NOT RUN |  |
| P09 | PASS | g-p9: with the server down the calendar shows its saved data under an "Offline" banner |
| P10 | PASS | g-p11/g-p12: an event made offline shows greyed, the banner counts "1 change waiting", and it turns normal when the server is back |
| P11 | NOT RUN |  |
| P12 | NOT RUN |  |
| P13 | NOT RUN |  |
| P14 | NOT RUN |  |
| P15 | NOT RUN |  |
| Q01 | PASS | s-dark1/s-dark2: events, hours, week strip and sleep band readable in dark mode |
| Q02 | PASS | s-dark1: header is black translucent over the colours, no glossy rim |
| Q03 | FIXED | FAIL found: p-ax at accessibility-large the week strip wrapped "30" to two lines, "W49" ran into the date and hour labels were cut; header text now stops growing at xxxLarge, hour labels shrink to fit (s-ax3-s) |
| Q04 | NOT RUN |  |
| Q05 | NOT RUN |  |
| Q06 | NOT RUN |  |
| Q07 | NOT RUN |  |
| Q08 | BLOCKED | VoiceOver cannot be driven through the Device Lab tools |
| Q09 | BLOCKED | VoiceOver cannot be driven through the Device Lab tools |
| Q10 | BLOCKED | VoiceOver cannot be driven through the Device Lab tools |
| Q11 | BLOCKED | Switch Control and a hardware keyboard focus cannot be driven |
| Q12 | BLOCKED | the simulator did not rotate with the keys and the tools have no rotate |
| Q13 | BLOCKED | no iPad simulator reserved for this thread |
| Q14 | NOT RUN |  |
| Q15 | NOT RUN |  |
| Q16 | NOT RUN |  |
| Q17 | NOT RUN |  |
| Q18 | BLOCKED | colour vision cannot be judged from stills |
| Q19 | NOT RUN |  |
| Q20 | NOT RUN |  |
| R01 | BLOCKED | timing cannot be measured from stills |
| R02 | BLOCKED | frame drops cannot be seen in stills |
| R03 | BLOCKED | pinch cannot be sent |
| R04 | NOT RUN |  |
| R05 | NOT RUN |  |
| R06 | BLOCKED | memory warnings cannot be sent |
| R07 | NOT RUN |  |
| R08 | NOT RUN |  |
| R09 | BLOCKED | system alerts cannot be raised during a drag |
| R10 | NOT RUN |  |
| S01 | NOT RUN |  |
| S02 | NOT RUN |  |
| S03 | NOT RUN |  |
| S04 | NOT RUN |  |
| S05 | NOT RUN |  |
| S06 | NOT RUN |  |
| S07 | NOT RUN |  |
| S08 | NOT RUN |  |
| S09 | NOT RUN |  |
| S10 | NOT RUN |  |
| T01 | PASS | p-nav1: a tap on a day selects it; the haptic cannot be felt on the simulator, so the haptic part is BLOCKED |
| T02 | NOT RUN |  |
| T03 | NOT RUN |  |
| T04 | NOT RUN |  |
| T05 | PASS | g-n: Today in the month view opens today's day view |
| T06 | PASS | g-n: year view opens with today in gold; Today in the year view goes to the current month |
| T07 | PASS | g-n: the back button reads the month in the day, the year in the month and is not there in the year |
| T08 | PASS | g-n: the back button reads the month in the day, the year in the month and is not there in the year |
| T09 | BLOCKED | A pinch, a gesture video or a drag with several fingers cannot be sent through the Device Lab input tools; needs a real device |
| T10 | BLOCKED | A pinch, a gesture video or a drag with several fingers cannot be sent through the Device Lab input tools; needs a real device |
| T11 | NOT RUN |  |
| T12 | NOT RUN |  |
| T13 | NOT RUN |  |
| T14 | NOT RUN |  |
| T15 | NOT RUN |  |
| T16 | NOT RUN |  |
| T17 | NOT RUN |  |
| T18 | NOT RUN |  |
| T19 | NOT RUN |  |
| T20 | NOT RUN |  |
