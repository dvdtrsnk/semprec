package cz.semprec.app.data

import kotlinx.serialization.SerializationException

/** The code of an error answer, or `null` when its body is missing or not an error document. */
internal fun ApiResponse.Failure.errorCode(): String? {
    val text = body ?: return null
    return try {
        ApiJson.decodeFromString(ApiErrorDto.serializer(), text).let { it.error?.code ?: it.code }
    } catch (_: SerializationException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    }
}
