package cz.alldots.app.data

import cz.alldots.app.domain.SessionUser
import kotlinx.serialization.Serializable

@Serializable
internal data class LoginRequest(
    val email: String,
    val password: String,
    val platform: String,
    val deviceId: String,
    val deviceName: String,
    val deviceKind: String,
    val osVersion: String,
    val appVersion: String,
)

@Serializable
internal data class UserDto(
    val id: String,
    val email: String,
    val locale: String,
    val role: String,
    val displayName: String? = null,
) {
    fun toDomain(): SessionUser = SessionUser(id, email, locale, role, displayName?.takeIf { it.isNotBlank() })
}

@Serializable
internal data class LoginResponse(val token: String, val user: UserDto)

@Serializable
internal data class SessionResponse(val user: UserDto)

@Serializable
internal data class PasswordResetRequest(val email: String)

@Serializable
internal data class PasswordResetConsumeRequest(val token: String, val newPassword: String)

/**
 * The error answer of `password-reset/consume`: `{ "error": message, "code", "details": { "field" } }`. Only the code
 * and the refused field are read.
 */
@Serializable
internal data class PasswordResetErrorDto(val code: String? = null, val details: PasswordResetErrorDetailsDto? = null)

@Serializable
internal data class PasswordResetErrorDetailsDto(val field: String? = null)
