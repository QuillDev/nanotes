package moe.quill.nanotes

object UpdateManifest {
  const val LATEST_MANIFEST_URL =
    "https://github.com/QuillDev/nanotes/releases/latest/download/latest.json"

  private val SHA256_REGEX = Regex("^[0-9a-fA-F]{64}$")

  fun normalizeVersion(raw: String): String =
    raw.trim().removePrefix("v").removePrefix("V")

  fun apkUrlForVersion(version: String): String =
    "https://github.com/QuillDev/nanotes/releases/download/v${normalizeVersion(version)}/nanotes.apk"

  fun checksumsUrlForVersion(version: String): String =
    "https://github.com/QuillDev/nanotes/releases/download/v${normalizeVersion(version)}/SHA256SUMS.txt"

  fun isTrustedApkUrl(url: String): Boolean =
    url.startsWith("https://github.com/QuillDev/nanotes/releases/") &&
      url.endsWith("/nanotes.apk")

  fun isValidSha256(value: String): Boolean =
    SHA256_REGEX.matches(value.trim())

  fun isNewerVersion(installed: String, candidate: String): Boolean {
    val a = parseVersionParts(installed) ?: return false
    val b = parseVersionParts(candidate) ?: return false
    val maxLen = maxOf(a.size, b.size)
    for (i in 0 until maxLen) {
      val av = if (i < a.size) a[i] else 0
      val bv = if (i < b.size) b[i] else 0
      if (bv != av) return bv > av
    }
    return false
  }

  fun parseApkSha256(sumsText: String): String? {
    for (rawLine in sumsText.lineSequence()) {
      val line = rawLine.trim()
      if (line.isEmpty()) continue
      val parts = line.split(Regex("\\s+"), limit = 2)
      if (parts.size != 2) continue
      val hash = parts[0].trim()
      val filename = parts[1].trim().removePrefix("*")
      if ((filename == "nanotes.apk" || filename.endsWith("/nanotes.apk")) && isValidSha256(hash)) {
        return hash.lowercase()
      }
    }
    return null
  }

  private fun parseVersionParts(raw: String): List<Int>? {
    val core = normalizeVersion(raw).substringBefore('-').substringBefore('+')
    if (core.isEmpty()) return null
    val parts = core.split('.')
    val parsed = ArrayList<Int>(parts.size)
    for (part in parts) {
      val num = part.toIntOrNull() ?: return null
      parsed.add(num)
    }
    return parsed
  }
}
