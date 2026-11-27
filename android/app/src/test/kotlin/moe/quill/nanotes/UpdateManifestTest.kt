package moe.quill.nanotes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateManifestTest {
  @Test
  fun comparesSemverVersionsCorrectly() {
    assertTrue(UpdateManifest.isNewerVersion("0.3.13", "0.3.14"))
    assertTrue(UpdateManifest.isNewerVersion("0.3.13", "v0.4.0"))
    assertTrue(UpdateManifest.isNewerVersion("0.3.9", "0.3.10"))
    assertTrue(UpdateManifest.isNewerVersion("0.3.13", "1.0.0"))
    assertFalse(UpdateManifest.isNewerVersion("0.3.13", "0.3.13"))
    assertFalse(UpdateManifest.isNewerVersion("0.3.14", "0.3.13"))
    assertFalse(UpdateManifest.isNewerVersion("0.3.13", ""))
  }

  @Test
  fun parsesNanotesApkChecksumFromSumsFile() {
    val sha = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
    val sums = """
      6366eb1afad8c6fa9eb2b00bdf384e0a301a9c93a42a33481af3cbd064d4de5e  NaNotes_0.3.13_aarch64.app.tar.gz
      ${sha.uppercase()}  nanotes.apk
    """.trimIndent()
    assertEquals(sha, UpdateManifest.parseApkSha256(sums))
    assertNull(UpdateManifest.parseApkSha256("deadbeef  nanotes.apk"))
    assertNull(UpdateManifest.parseApkSha256("$sha  other.apk"))
  }

  @Test
  fun validatesTrustedGithubReleaseApkUrls() {
    assertTrue(UpdateManifest.isTrustedApkUrl(UpdateManifest.apkUrlForVersion("0.3.14")))
    assertFalse(UpdateManifest.isTrustedApkUrl("https://evil.example/nanotes.apk"))
    assertFalse(UpdateManifest.isTrustedApkUrl("https://github.com/QuillDev/nanotes/releases/download/v0.3.14/other.exe"))
  }
}
