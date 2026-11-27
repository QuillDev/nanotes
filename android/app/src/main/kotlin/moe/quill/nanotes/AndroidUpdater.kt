package moe.quill.nanotes

import android.app.Activity
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class AndroidUpdater(
  private val activity: Activity,
  private val webView: WebView,
) {
  private data class PendingInstall(
    val version: String,
    val apkUrl: String,
    val sha256: String,
  )

  private val executor = Executors.newSingleThreadExecutor()
  private val installActive = AtomicBoolean(false)
  @Volatile
  private var pendingInstall: PendingInstall? = null

  private fun installedVersionName(): String {
    return try {
      @Suppress("DEPRECATION")
      val info = activity.packageManager.getPackageInfo(activity.packageName, 0)
      info.versionName?.takeIf { it.isNotBlank() } ?: BuildConfig.VERSION_NAME
    } catch (_: Exception) {
      BuildConfig.VERSION_NAME
    }
  }

  @JavascriptInterface
  fun checkForUpdate(requestId: String) {
    executor.execute {
      try {
        val manifestText = fetchText(UpdateManifest.LATEST_MANIFEST_URL)
        val json = JSONObject(manifestText)
        val latest = UpdateManifest.normalizeVersion(json.optString("version", ""))
        val installed = installedVersionName()
        if (latest.isEmpty() || !UpdateManifest.isNewerVersion(installed, latest)) {
          dispatchEvent(
            JSONObject()
              .put("type", "check")
              .put("requestId", requestId)
              .put("available", false),
          )
          return@execute
        }

        val sumsText = fetchText(UpdateManifest.checksumsUrlForVersion(latest))
        val sha256 = UpdateManifest.parseApkSha256(sumsText)
          ?: throw IllegalStateException("Release checksum for nanotes.apk not found")

        dispatchEvent(
          JSONObject()
            .put("type", "check")
            .put("requestId", requestId)
            .put("available", true)
            .put("version", latest)
            .put("apkUrl", UpdateManifest.apkUrlForVersion(latest))
            .put("sha256", sha256),
        )
      } catch (e: Exception) {
        Log.w(TAG, "Update check failed", e)
        dispatchEvent(
          JSONObject()
            .put("type", "check")
            .put("requestId", requestId)
            .put("error", e.message ?: "Update check failed"),
        )
      }
    }
  }

  @JavascriptInterface
  fun downloadAndInstall(version: String, apkUrl: String, sha256: String) {
    if (!UpdateManifest.isTrustedApkUrl(apkUrl) || !UpdateManifest.isValidSha256(sha256)) {
      dispatchEvent(
        JSONObject()
          .put("type", "install-error")
          .put("message", "Invalid update metadata"),
      )
      return
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      !activity.packageManager.canRequestPackageInstalls()
    ) {
      pendingInstall = PendingInstall(version, apkUrl, sha256)
      dispatchEvent(JSONObject().put("type", "install-permission"))
      activity.runOnUiThread {
        try {
          val intent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${activity.packageName}"),
          )
          activity.startActivity(intent)
        } catch (e: Exception) {
          pendingInstall = null
          dispatchEvent(
            JSONObject()
              .put("type", "install-error")
              .put("message", e.message ?: "Could not open Android install permission settings"),
          )
        }
      }
      return
    }

    startDownloadAndInstall(version, apkUrl, sha256)
  }

  fun onResume() {
    val pending = pendingInstall ?: return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
      activity.packageManager.canRequestPackageInstalls()
    ) {
      pendingInstall = null
      dispatchEvent(JSONObject().put("type", "install-started"))
      startDownloadAndInstall(pending.version, pending.apkUrl, pending.sha256)
    } else {
      pendingInstall = null
      dispatchEvent(JSONObject().put("type", "install-cancelled"))
    }
  }

  fun shutdown() {
    executor.shutdownNow()
  }

  private fun startDownloadAndInstall(version: String, apkUrl: String, expectedSha256: String) {
    if (!installActive.compareAndSet(false, true)) {
      return
    }
    executor.execute {
      var partFile: File? = null
      try {
        dispatchEvent(JSONObject().put("type", "install-progress").put("percent", 0))
        val updatesDir = File(activity.cacheDir, "updates").apply { mkdirs() }
        updatesDir.listFiles()?.forEach { it.delete() }

        val safeVersion = UpdateManifest.normalizeVersion(version).replace(Regex("[^0-9A-Za-z._-]"), "_")
        val part = File(updatesDir, "nanotes-$safeVersion.apk.part")
        val target = File(updatesDir, "nanotes-$safeVersion.apk")
        partFile = part

        val actualSha256 = downloadFile(apkUrl, part) { percent ->
          dispatchEvent(JSONObject().put("type", "install-progress").put("percent", percent))
        }
        if (!actualSha256.equals(expectedSha256.trim(), ignoreCase = true)) {
          part.delete()
          throw IllegalStateException("Downloaded APK checksum mismatch")
        }
        if (!part.renameTo(target)) {
          part.copyTo(target, overwrite = true)
          part.delete()
        }
        dispatchEvent(JSONObject().put("type", "install-progress").put("percent", 100))
        commitInstallerSession(target)
      } catch (e: Exception) {
        partFile?.delete()
        installActive.set(false)
        Log.w(TAG, "Android update failed", e)
        dispatchEvent(
          JSONObject()
            .put("type", "install-error")
            .put("message", e.message ?: "Update failed"),
        )
      }
    }
  }

  private fun commitInstallerSession(apk: File) {
    val installer = activity.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
      setAppPackageName(activity.packageName)
      setSize(apk.length())
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
      }
    }
    val sessionId = installer.createSession(params)
    installer.openSession(sessionId).use { session ->
      session.openWrite("nanotes.apk", 0, apk.length()).use { output ->
        apk.inputStream().use { input ->
          input.copyTo(output, bufferSize = 32 * 1024)
        }
        session.fsync(output)
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
      val callback = PendingIntent.getBroadcast(
        activity,
        sessionId,
        Intent(activity, InstallResultReceiver::class.java).setPackage(activity.packageName),
        flags,
      )
      session.commit(callback.intentSender)
    }
  }

  private fun openConnection(rawUrl: String): HttpURLConnection {
    var currentUrl = rawUrl
    val ua = "nanotes-android/${installedVersionName()}"
    for (hop in 0..5) {
      val conn = (URL(currentUrl).openConnection() as HttpURLConnection).apply {
        instanceFollowRedirects = false
        connectTimeout = 15_000
        readTimeout = 30_000
        setRequestProperty("User-Agent", ua)
      }
      val code = conn.responseCode
      if (code in 300..399) {
        val location = conn.getHeaderField("Location")
        conn.disconnect()
        if (location.isNullOrBlank()) {
          throw IllegalStateException("Redirect missing Location header ($code)")
        }
        currentUrl = URL(URL(currentUrl), location).toString()
        continue
      }
      if (code !in 200..299) {
        conn.disconnect()
        throw IllegalStateException("Download failed (HTTP $code)")
      }
      return conn
    }
    throw IllegalStateException("Too many redirects")
  }

  private fun fetchText(url: String): String {
    val conn = openConnection(url)
    return try {
      conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    } finally {
      conn.disconnect()
    }
  }

  private fun downloadFile(
    url: String,
    dest: File,
    onProgress: (Int) -> Unit,
  ): String {
    val conn = openConnection(url)
    return try {
      val total = conn.contentLengthLong
      val digest = MessageDigest.getInstance("SHA-256")
      var downloaded = 0L
      var lastPercent = 0
      val buffer = ByteArray(32 * 1024)
      conn.inputStream.use { input ->
        FileOutputStream(dest).use { output ->
          while (true) {
            val read = input.read(buffer)
            if (read <= 0) break
            output.write(buffer, 0, read)
            digest.update(buffer, 0, read)
            downloaded += read
            if (total > 0) {
              val pct = ((downloaded * 100L) / total).toInt().coerceIn(0, 99)
              if (pct > lastPercent) {
                lastPercent = pct
                onProgress(pct)
              }
            }
          }
          output.fd.sync()
        }
      }
      digest.digest().joinToString("") { "%02x".format(it) }
    } finally {
      conn.disconnect()
    }
  }

  private fun dispatchEvent(payload: JSONObject) {
    val script =
      "window.__nanotesAndroidUpdaterEvent && window.__nanotesAndroidUpdaterEvent(${payload});"
    webView.post {
      webView.evaluateJavascript(script, null)
    }
  }

  companion object {
    private const val TAG = "NanotesUpdater"

    @Volatile
    var current: AndroidUpdater? = null

    fun notifyInstallSuccess() {
      current?.let { updater ->
        updater.installActive.set(false)
        updater.dispatchEvent(JSONObject().put("type", "install-success"))
      }
    }

    fun notifyInstallCancelled() {
      current?.let { updater ->
        updater.installActive.set(false)
        updater.dispatchEvent(JSONObject().put("type", "install-cancelled"))
      }
    }

    fun notifyInstallError(message: String) {
      current?.let { updater ->
        updater.installActive.set(false)
        updater.dispatchEvent(
          JSONObject()
            .put("type", "install-error")
            .put("message", message),
        )
      }
    }
  }
}
