// DashboardWebViewActivity.kt — hosts the Distort web dashboard inside an
// Android WebView and registers RecoveryBridge as a JavascriptInterface so
// the dashboard's RecoveryEngine can drive DistortVpnService natively.
//
// Launched from MainActivity via the "Open Web Dashboard" button.
//
// Architecture:
//   ┌────────────────────────────────────────────────────────────┐
//   │  DashboardWebViewActivity (this file)                       │
//   │    └── WebView ── loads ──> https://distort.app            │
//   │         │                                                   │
//   │         └── addJavascriptInterface(RecoveryBridge,         │
//   │                                       "DistortNative")     │
//   │                               │                             │
//   │                               ▼                             │
//   │  window.DistortNative.connect(uri, timeout)  (in JS land)  │
//   │         │                                                   │
//   │         ▼                                                   │
//   │  RecoveryBridge.connect()  (Kotlin, binder thread)         │
//   │         │                                                   │
//   │         ▼                                                   │
//   │  startForegroundService(DistortVpnService.ACTION_CONNECT)  │
//   │         │                                                   │
//   │         ▼                                                   │
//   │  DistortVpnService.verifyTrafficThroughProxy()             │
//   │         │                                                   │
//   │         ▼                                                   │
//   │  RecoveryBridge.VerificationSlot.report(...)               │
//   │         │                                                   │
//   │         ▼                                                   │
//   │  AndroidNativeEngine.connect() unblocks + returns result   │
//   └────────────────────────────────────────────────────────────┘
//
// SECURITY:
//   - JavaScript is enabled (required for the dashboard to run), but the
//     dashboard is loaded over HTTPS from distort.app — never from
//     cleartext HTTP except for local dev (localhost:3000).
//   - The DistortNative bridge is ONLY injected on this trusted origin.
//     We do NOT inject it on arbitrary navigations — see the WebViewClient
//     below which guards against the user navigating to untrusted URLs.
//   - The bridge's connect() method takes a configUri containing real
//     credentials. It is NEVER logged — see the SECURITY comment in
//     RecoveryBridge.connect().

package com.distort.app

import android.annotation.SuppressLint
import android.app.Activity
import android.net.http.SslError
import android.os.Bundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class DashboardWebViewActivity : AppCompatActivity() {

    private val TAG = "DistortWebView"
    private lateinit var webView: WebView
    private lateinit var bridge: RecoveryBridge

    // The dashboard URL. In production this is https://distort.app.
    // For local dev, override with `adb shell setprop distort.dashboard_url http://10.0.2.2:3000`
    // OR build a debug variant with DASHBOARD_URL set to localhost.
    private val DASHBOARD_URL_PRODUCTION = "https://distort.app"
    private val DASHBOARD_URL_DEV = "http://10.0.2.2:3000" // 10.0.2.2 == host loopback in the Android emulator

    // Trust list for injecting the DistortNative bridge. We only inject on
    // these exact origins — never on third-party URLs the user might navigate to.
    private val TRUSTED_ORIGINS = setOf(
        "https://distort.app",
        "https://www.distort.app",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://10.0.2.2:3000" // emulator-only dev access to host's localhost
    )

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Use the dev URL if a system property is set, otherwise production.
        val dashboardUrl = try {
            System.getProperty("distort.dashboard_url", DASHBOARD_URL_PRODUCTION)
        } catch (_: Throwable) {
            DASHBOARD_URL_PRODUCTION
        }

        Log.i(TAG, "Loading dashboard: $dashboardUrl")

        // Build a minimal layout: a small header label + the WebView fills the rest.
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        val header = TextView(this).apply {
            text = "DISTORT · Web Dashboard (native bridge active)"
            textSize = 11f
            setPadding(24, 16, 24, 8)
        }
        root.addView(header)

        webView = WebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }
        root.addView(webView)
        setContentView(root)

        // Configure the WebView
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true        // required for the dashboard's IndexedDB usage
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            // DO NOT allow mixed content — the dashboard must be HTTPS in production.
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // Allow the WebView to make cross-origin fetches to the Distort API.
            // The dashboard itself uses fetch() against /api/* (same-origin) +
            // against https://1.1.1.1 etc. for diagnosis (CORS-permitting).
            javaScriptCanOpenWindowsAutomatically = false
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
            // User agent — let the dashboard know it's running inside the Android app
            // so it can show the right UI hints (e.g. "native bridge active").
            userAgentString = (userAgentString ?: "") + " DistortAndroid/1.0"
        }

        // Create the bridge. We hold a reference so we can detach it on destroy.
        bridge = RecoveryBridge(this, webView)

        // Register a WebViewClient that ONLY injects the DistortNative bridge
        // on trusted origins. This prevents a malicious redirect from
        // silently gaining access to native tunnel operations.
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                Log.i(TAG, "onPageStarted: $url")
                // Remove the bridge by default; re-add only if URL is trusted.
                view?.removeJavascriptInterface("DistortNative")
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                Log.i(TAG, "onPageFinished: $url")
                if (url != null && isTrustedOrigin(url)) {
                    // Inject the bridge now that the page is loaded on a trusted origin.
                    // addJavascriptInterface is idempotent — calling it again just rebinds.
                    view?.addJavascriptInterface(bridge, "DistortNative")
                    Log.i(TAG, "DistortNative bridge injected on trusted origin: $url")
                } else {
                    Log.w(TAG, "Refusing to inject DistortNative on untrusted origin: $url")
                }
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val url = request?.url?.toString() ?: return false
                // Allow same-site navigations within trusted origins; block
                // navigations to arbitrary external URLs (the user should use
                // a real browser for those). The dashboard shouldn't be
                // navigating the WebView off-origin in normal operation.
                return !isTrustedOrigin(url).also { trusted ->
                    if (!trusted) {
                        Log.w(TAG, "Blocking off-origin navigation to: $url")
                    }
                }
            }

            override fun onReceivedSslError(
                view: WebView?,
                handler: SslErrorHandler?,
                error: SslError?
            ) {
                // NEVER proceed on SSL errors — fail closed. The dashboard must
                // be served over a valid HTTPS cert. A MITM-able cert means we
                // could be loading attacker-controlled JS that would get native
                // bridge access.
                Log.e(TAG, "SSL error — refusing to proceed: ${error?.toString()}")
                handler?.cancel()
            }

            private fun isTrustedOrigin(url: String): Boolean {
                // SECURITY (P1-ج): use java.net.URI to parse scheme + host + port
                // EXACTLY, then compare against the trust list.
                //
                // The previous implementation used `url.startsWith(it)`, which is
                // vulnerable to prefix attacks: "https://distort.app.evil.com"
                // would match "https://distort.app" and get native bridge access.
                //
                // We now build the canonical origin string (scheme://host[:port])
                // and do an EXACT match against TRUSTED_ORIGINS.
                try {
                    val parsed = java.net.URI(url)
                    val scheme = parsed.scheme?.lowercase() ?: return false
                    val host = parsed.host?.lowercase() ?: return false
                    val port = parsed.port // -1 if not specified

                    // Build the canonical origin string
                    val origin = when {
                        // Default ports — omit from origin
                        (scheme == "https" && port == 443) || (scheme == "http" && port == 80) ->
                            "$scheme://$host"
                        port > 0 ->
                            "$scheme://$host:$port"
                        else ->
                            "$scheme://$host"
                    }
                    return TRUSTED_ORIGINS.contains(origin)
                } catch (e: Exception) {
                    Log.e(TAG, "isTrustedOrigin: failed to parse URL '$url': ${e.message}")
                    return false
                }
            }
        }

        // WebChromeClient — needed for console.log from JS to show up in logcat
        // and for any alert/confirm dialogs the dashboard might use.
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: android.webkit.ConsoleMessage?): Boolean {
                Log.i(TAG, "[js] ${consoleMessage?.message()} (source: ${consoleMessage?.sourceId()}:${consoleMessage?.lineNumber()})")
                return true
            }
        }

        // Enable WebView debugging in debug builds (chrome://inspect) — disabled by default
        // in release builds to avoid leaking internal state.
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        // Load the dashboard URL
        webView.loadUrl(dashboardUrl)
    }

    override fun onDestroy() {
        // Clean up the WebView to avoid leaks
        try {
            webView.removeJavascriptInterface("DistortNative")
            webView.stopLoading()
            webView.destroy()
        } catch (e: Exception) {
            Log.w(TAG, "WebView cleanup failed: ${e.message}")
        }
        super.onDestroy()
    }

    // Handle the hardware Back button — navigate WebView history instead of
    // exiting immediately (so the user can Back out of deep dashboard views).
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (this::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }
}
