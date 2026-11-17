package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

data class HomeState(
    val phase: HomePhase = HomePhase.LOADING,
    val items: List<HomeItem> = emptyList(),
    /** The expected failure behind [HomePhase.ERROR]; `null` for an unexpected one, which has no typed reason. */
    val failure: FailureKind? = null,
)
