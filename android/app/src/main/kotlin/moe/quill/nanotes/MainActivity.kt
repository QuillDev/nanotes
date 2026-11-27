package moe.quill.nanotes

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.edit
import androidx.core.graphics.toColorInt
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

/**
 * Hosts the nanotes web app from the user's own server in a WebView. The UI comes from the
 * server, so a server deploy updates the app; only this shell ships as an APK, and it updates
 * itself through [AndroidUpdater], which the web app reaches as `window.NanotesAndroidUpdater`.
 */
class MainActivity : ComponentActivity() {
    private val preferences by lazy { getSharedPreferences("shell", MODE_PRIVATE) }
    private lateinit var root: FrameLayout
    private var webView: WebView? = null
    private var updater: AndroidUpdater? = null

    private var origin: ServerOrigin?
        get() = preferences.getString("server_origin", null)?.let(ServerOrigin::parse)
        set(value) = preferences.edit { putString("server_origin", value?.value) }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        root = FrameLayout(this).apply { setBackgroundColor(BG) }
        // Keep the page clear of the status bar, navigation bar, notch and keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            view.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
        onBackPressedDispatcher.addCallback(this, backCallback)

        val server = origin
        if (server == null) {
            showServerPrompt(null)
        } else {
            showWebApp(server, savedInstanceState)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWebApp(server: ServerOrigin, savedInstanceState: Bundle?) {
        destroyWebView()
        root.removeAllViews()
        val web = WebView(this).apply {
            setBackgroundColor(BG)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            // Passkeys inside the WebView, bound to this app by the server's assetlinks.json.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
                WebSettingsCompat.setWebAuthenticationSupport(settings, WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP)
            }
            webViewClient = ShellWebViewClient(server)
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        val bridge = AndroidUpdater(this, web)
        updater = bridge
        AndroidUpdater.current = bridge
        web.addJavascriptInterface(bridge, "NanotesAndroidUpdater")
        webView = web
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(server.url)
        }
    }

    private fun destroyWebView() {
        if (AndroidUpdater.current === updater) {
            AndroidUpdater.current = null
        }
        updater?.shutdown()
        updater = null
        webView?.destroy()
        webView = null
    }

    private inner class ShellWebViewClient(private val server: ServerOrigin) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (server.opensInApp(request.url.toString())) {
                return false
            }
            openExternally(request.url)
            return true
        }

        // A killed renderer would otherwise crash the app.
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view === webView) {
                root.removeView(view)
                showWebApp(server, null)
            }
            return true
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) {
                showUnreachable(server, error.description?.toString())
            }
        }
    }

    private fun openExternally(uri: Uri) {
        runCatching { CustomTabsIntent.Builder().build().launchUrl(this, uri) }
            .recoverCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
    }

    private fun showServerPrompt(error: String?) {
        destroyWebView()
        root.removeAllViews()
        val input = EditText(this).apply {
            hint = "notes.example.com"
            setText(origin?.value.orEmpty())
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
            isSingleLine = true
            inputType = android.text.InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
        }
        val message = label(error ?: "nanotes server address", if (error == null) Color.LTGRAY else ERROR)
        val connect = Button(this).apply { text = "Connect" }
        val submit = {
            val parsed = ServerOrigin.parse(input.text.toString())
            if (parsed == null) {
                message.text = "Enter an address like https://notes.example.com"
                message.setTextColor(ERROR)
            } else {
                origin = parsed
                showWebApp(parsed, null)
            }
        }
        connect.setOnClickListener { submit() }
        input.setOnEditorActionListener { _, _, _ ->
            submit()
            true
        }
        root.addView(column(label("nanotes", ACCENT, 30f), message, input, connect))
        input.requestFocus()
    }

    private fun showUnreachable(server: ServerOrigin, detail: String?) {
        root.removeAllViews()
        webView?.stopLoading()
        val retry = Button(this).apply {
            text = "Retry"
            setOnClickListener { showWebApp(server, null) }
        }
        val change = Button(this).apply {
            text = "Change server"
            setOnClickListener { showServerPrompt(null) }
        }
        root.addView(column(label("Can't reach ${server.value}", Color.WHITE, 18f), label(detail.orEmpty(), Color.GRAY), retry, change))
    }

    override fun onResume() {
        super.onResume()
        updater?.onResume()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView?.saveState(outState)
    }

    override fun onPause() {
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        destroyWebView()
        super.onDestroy()
    }

    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            val web = webView
            if (web != null && web.canGoBack()) {
                web.goBack()
            } else {
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
                isEnabled = true
            }
        }
    }

    private fun label(text: String, color: Int, size: Float = 15f) = TextView(this).apply {
        this.text = text
        setTextColor(color)
        textSize = size
        gravity = Gravity.CENTER
    }

    private fun column(vararg views: View) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        val pad = (24 * resources.displayMetrics.density).toInt()
        setPadding(pad, pad, pad, pad)
        views.forEach { addView(it, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)) }
        layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    }

    companion object {
        private val BG = "#09090B".toColorInt()
        private val ACCENT = "#DB2777".toColorInt()
        private val ERROR = "#F87171".toColorInt()
    }
}
