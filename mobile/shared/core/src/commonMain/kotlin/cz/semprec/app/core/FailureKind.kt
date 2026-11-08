package cz.semprec.app.core

/** Expected failures cross the domain boundary as values; cancellation remains an exception. */
enum class FailureKind { UNAVAILABLE, INVALID_DATA }
