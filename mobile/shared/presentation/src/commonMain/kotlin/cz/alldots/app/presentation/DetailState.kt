package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind

data class DetailState(
    val phase: DetailPhase = DetailPhase.LOADING,
    val item: HomeItem? = null,
    /** The expected failure behind [DetailPhase.ERROR]; `null` for an unexpected one, which has no typed reason. */
    val failure: FailureKind? = null,
)
