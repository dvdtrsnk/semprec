package cz.alldots.app.core

/**
 * Expected failures cross the domain boundary as values; cancellation remains an exception.
 *
 * [UNAVAILABLE] is a request that could not complete (no network, a server error), [INVALID_DATA] an answer the
 * app could not read, [UNAUTHORIZED] a missing, expired or refused session or credentials, [NOT_FOUND] a thing
 * the server does not have, and [REJECTED] a request the server refused as invalid or in conflict.
 */
enum class FailureKind { UNAVAILABLE, INVALID_DATA, UNAUTHORIZED, NOT_FOUND, REJECTED }
