package moe.quill.nanotes

import java.net.URI

/** The nanotes server this install talks to, normalized to `scheme://host[:port]`. */
@JvmInline
value class ServerOrigin private constructor(val value: String) {
    val url: String get() = "$value/"

    /** Only the server's own pages stay inside the app; every other link opens in the browser. */
    fun opensInApp(link: String): Boolean {
        val uri = runCatching { URI(link) }.getOrNull() ?: return false
        return originOf(uri) == value
    }

    companion object {
        /** Accepts `notes.example.com`, `https://notes.example.com/` or `http://10.0.0.5:8098`; null otherwise. */
        fun parse(input: String): ServerOrigin? {
            val trimmed = input.trim().trimEnd('/')
            if (trimmed.isEmpty()) {
                return null
            }
            val withScheme = if ("://" in trimmed) trimmed else "https://$trimmed"
            val uri = runCatching { URI(withScheme) }.getOrNull() ?: return null
            val bare = uri.rawPath.isNullOrEmpty() && uri.rawQuery == null && uri.rawFragment == null && uri.rawUserInfo == null
            return if (bare) originOf(uri)?.let(::ServerOrigin) else null
        }

        private fun originOf(uri: URI): String? {
            val scheme = uri.scheme?.lowercase()
            val host = uri.host?.lowercase()
            if (scheme !in setOf("http", "https") || host.isNullOrEmpty()) {
                return null
            }
            val defaultPort = if (scheme == "https") 443 else 80
            val port = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
            return "$scheme://$host$port"
        }
    }
}
