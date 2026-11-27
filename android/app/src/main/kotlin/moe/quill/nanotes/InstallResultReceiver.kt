package moe.quill.nanotes

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log
import androidx.core.content.IntentCompat

class InstallResultReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
    when (status) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        val confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)
          ?: run {
            AndroidUpdater.notifyInstallError("System install confirmation was unavailable")
            return
          }
        try {
          context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
          Log.w(TAG, "Failed to open install confirmation", e)
          AndroidUpdater.notifyInstallError(e.message ?: "Could not open install confirmation")
        }
      }
      PackageInstaller.STATUS_SUCCESS -> {
        AndroidUpdater.notifyInstallSuccess()
      }
      PackageInstaller.STATUS_FAILURE_ABORTED -> {
        AndroidUpdater.notifyInstallCancelled()
      }
      else -> {
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
          ?: "Install failed (status $status)"
        Log.w(TAG, "Update install failed: $message")
        AndroidUpdater.notifyInstallError(message)
      }
    }
  }

  companion object {
    private const val TAG = "NanotesUpdater"
  }
}
