package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.RepositoryResult
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.serializer

/** What a backend call answered: a success with its raw body, or the expected failure it maps to. */
sealed interface ApiResponse {
    /** [etag] is the `ETag` header of the answer, quoted as the server sent it, or `null` when it sent none. */
    data class Success(val status: Int, val body: String, val etag: String? = null) : ApiResponse
    data class Failure(val kind: FailureKind, val status: Int?) : ApiResponse
}

/** What a binary download answered: the bytes with their media type, or the expected failure it maps to. */
sealed interface ApiBytesResponse {
    class Success(val status: Int, val mimeType: String, val bytes: ByteArray) : ApiBytesResponse
    data class Failure(val kind: FailureKind, val status: Int?) : ApiBytesResponse
}

/** The one JSON configuration of the wire: unknown fields are ignored so the server may add fields freely. */
val ApiJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = false
}

/** Decodes a success body as [T]; an unreadable body is [FailureKind.INVALID_DATA], never an exception. */
inline fun <reified T> ApiResponse.decode(): RepositoryResult<T> = when (this) {
    is ApiResponse.Failure -> RepositoryResult.Failure(kind)
    is ApiResponse.Success -> try {
        RepositoryResult.Content(ApiJson.decodeFromString(serializer<T>(), body))
    } catch (_: SerializationException) {
        RepositoryResult.Failure(FailureKind.INVALID_DATA)
    } catch (_: IllegalArgumentException) {
        RepositoryResult.Failure(FailureKind.INVALID_DATA)
    }
}

/** A success whose body does not matter. */
fun ApiResponse.ignoreBody(): RepositoryResult<Unit> = when (this) {
    is ApiResponse.Failure -> RepositoryResult.Failure(kind)
    is ApiResponse.Success -> RepositoryResult.Content(Unit)
}

/** Parses a success body as a JSON tree, for screens that read open-ended property maps. */
fun ApiResponse.decodeTree(): RepositoryResult<JsonElement> = decode<JsonElement>()
