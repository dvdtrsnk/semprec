package cz.semprec.app.data

import cz.semprec.app.domain.SessionUser
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
