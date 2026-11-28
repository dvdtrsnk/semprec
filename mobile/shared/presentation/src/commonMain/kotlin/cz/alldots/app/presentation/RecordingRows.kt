package cz.alldots.app.presentation

import cz.alldots.app.domain.RecordingEntry

internal fun RecordingEntry.toRow(): RecordingRow = RecordingRow(
    id = id,
    name = name,
    date = date,
    durationSeconds = durationSeconds,
    status = status,
    pairing = pairing,
    eventName = eventName,
    shortSummary = shortSummary,
)
