package moe.quill.nanotes

import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var updater: AndroidUpdater? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Keep the app clear of the status bar, navigation bar, notch and keyboard.
    val root = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    val bridge = AndroidUpdater(this, webView)
    updater = bridge
    AndroidUpdater.current = bridge
    webView.addJavascriptInterface(bridge, "NanotesAndroidUpdater")
  }

  override fun onResume() {
    super.onResume()
    updater?.onResume()
  }

  override fun onDestroy() {
    if (AndroidUpdater.current === updater) {
      AndroidUpdater.current = null
    }
    updater?.shutdown()
    updater = null
    super.onDestroy()
  }
}
