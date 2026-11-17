package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

/**
 * Something that did not go through: [kind] is the expected reason, or `null` for an unexpected failure, which has no
 * typed reason. A state that holds one is "failed" even when [kind] is `null`.
 */
data class Failed(val kind: FailureKind?)
