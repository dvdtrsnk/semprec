package cz.semprec.app.presentation

import cz.semprec.app.domain.RecordingEntry

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
