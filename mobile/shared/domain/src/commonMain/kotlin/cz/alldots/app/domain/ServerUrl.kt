package cz.alldots.app.domain

private val SCHEME = Regex("^[A-Za-z][A-Za-z0-9+.-]*://")
private val HOST = Regex("^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$")

/**
 * The base URL a person typed as their server: `alldots.example.com` becomes `https://alldots.example.com`,
 * a trailing slash is dropped, and `http://` is accepted only for a local address. Anything else, such as a path,
 * another scheme or a blank value, is `null`.
 */
fun normalizeServerUrl(input: String): String? {
    val trimmed = input.trim().trimEnd('/')
    val hasScheme = SCHEME.containsMatchIn(trimmed)
    val scheme = if (hasScheme) trimmed.substringBefore("://").lowercase() else "https"
    val host = if (hasScheme) trimmed.substringAfter("://") else trimmed
    val acceptable = trimmed.isNotEmpty() && HOST.matches(host) &&
        (scheme == "https" || (scheme == "http" && isLocalHost(host.substringBefore(':'))))
    return if (acceptable) "$scheme://$host" else null
}

private fun isLocalHost(host: String): Boolean =
    host == "localhost" || host == "127.0.0.1" || host.endsWith(".local") || host.endsWith(".ts.net")
