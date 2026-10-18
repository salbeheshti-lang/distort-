// RecoveryBridge.kt — bridges the RecoveryEngine (web/JS) to DistortVpnService (Android/Kotlin)
//
// The web dashboard's RecoveryEngine cannot directly call Android APIs.
// Instead, the Android app hosts a small WebView that loads the dashboard,
// and a JavascriptInterface (this class) that exposes native tunnel operations.
//
// Flow:
//   1. User opens Distort app on Android → taps "Open Web Dashboard".
//   2. DashboardWebViewActivity creates a WebView loading https://distort.app
//      (or localhost:3000 for dev) and registers this class as "DistortNative".
//   3. RecoveryEngine.createTunnelEngine() detects `window.DistortNative`
//      and returns an AndroidNativeEngine instead of BrowserOnlyEngine.
//   4. RecoveryEngine calls DistortNative.connect(configUri, timeoutMs).
//   5. This JavascriptInterface method launches DistortVpnService with the
//      config and BLOCKS (with a timeout) until the service's verification
//      thread completes (see DistortVpnService.verifyTrafficThroughProxy).
//   6. The method returns a JSON string with { started, trafficVerified,
//      exitIp, realIp, error, latencyMs } — the exact shape of TunnelEngineResult
//      in src/lib/emergency-connectivity/recovery-engine.ts.
//   7. AndroidNativeEngine JSON.parses the result and returns it.
//
// CRITICAL HONESTY INVARIANT:
//   This bridge NEVER returns {started:true, trafficVerified:true} unless the
//   underlying DistortVpnService has actually verified traffic through the
//   tunnel (exit IP differs from real IP). It does NOT fake a "connected"
//   state — see DistortVpnService.verifyTrafficThroughProxy for the real check.
//
// THREADING NOTE:
//   JavascriptInterface methods are invoked on a private binder thread, NOT on
//   the UI thread. We block the calling thread with a CountDownLatch until the
//   VPN service finishes verification. The VPN service itself runs its
//   verification on a background thread, so blocking here is safe.

package com.distort.app

import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class RecoveryBridge(
    private val context: Context,
    @Suppress("unused") private val webView: WebView
) {
    private val TAG = "DistortBridge"

    /**
     * Last connection result set by the VPN service's verification thread.
     * Used by isRunning() / getExitIp() to return live state without
     * blocking on a fresh connect() call.
     */
    private val lastResultRef = AtomicReference<ConnectResult?>(null)

    /**
     * Latch used to block connect() until the VPN service reports a final
     * verification outcome (or the timeout elapses).
     */
    private var connectLatch: CountDownLatch? = null

    // -------------------------------------------------------------------------
    // JavascriptInterface-exposed methods (called from JS via window.DistortNative)
    // -------------------------------------------------------------------------

    /**
     * Identify the platform so the JS side can pick AndroidNativeEngine.
     * Matches TunnelEngine.platform in recovery-engine.ts.
     */
    @JavascriptInterface
    fun getPlatform(): String = "android-native"

    /**
     * Whether this bridge can actually spawn a real VPN tunnel (xray-core
     * via VpnService). Always true for Android — the binary ships in the APK.
     */
    @JavascriptInterface
    fun canConnect(): Boolean = true

    /**
     * Start a VPN tunnel with the given config URI and BLOCK until the
     * service verifies (or fails to verify) real traffic through it.
     *
     * Returns a JSON string matching the TunnelEngineResult type:
     *   {
     *     "started":        Boolean,   // service accepted the config + xray launched
     *     "trafficVerified": Boolean,  // exit IP != real IP via verifyTrafficThroughProxy
     *     "exitIp":          String|null,
     *     "realIp":          String|null,
     *     "error":           String|null,
     *     "latencyMs":       Int|null
     *   }
     *
     * SECURITY: configUri contains real credentials (UUID / password). It is
     * NEVER logged. Only the success/failure + scrubbed reason is persisted.
     */
    @JavascriptInterface
    fun connect(configUri: String, timeoutMs: Int): String {
        Log.i(TAG, "connect() called — timeoutMs=$timeoutMs, uriLen=${configUri.length}")
        try {
            // --- Validate input ---------------------------------------------------
            if (configUri.isBlank() || configUri.length < 10) {
                return failResult("Empty or too-short config URI").toJson()
            }
            val scheme = configUri.substringBefore("://").lowercase()
            if (scheme !in setOf("vless", "vmess", "trojan", "ss")) {
                return failResult("Unsupported protocol: '$scheme' (need vless/vmess/trojan/ss)").toJson()
            }

            // --- If a tunnel is already running, disconnect it first ------------
            if (isRunning()) {
                Log.i(TAG, "Existing tunnel is running — disconnecting before reconnect")
                disconnectInternal(waitForStop = true, timeoutMs = 3000)
            }

            // --- Prepare VPN permission -----------------------------------------
            // VpnService.prepare() returns null if permission is already granted.
            // From a non-Activity context we cannot launch the consent dialog,
            // so if the user has never granted VPN permission, we return a clear
            // error instead of silently failing.
            val prepareIntent = VpnService.prepare(context)
            if (prepareIntent != null) {
                Log.w(TAG, "VPN permission not granted yet — user must grant it once from MainActivity")
                // We CANNOT start the service here without permission — that would
                // cause the TUN fd to be null and the service to silently stop.
                // Be honest: report that permission is missing.
                return failResult(
                    "VPN permission not granted. Open the Distort app and tap 'Grant VPN Permission' once, then retry."
                ).toJson()
            }

            // --- Wire up the verification latch BEFORE we start the service ----
            // The service's verification thread will countDown() the latch when it
            // finishes (success or failure). We register it via a static slot so
            // the service can find it without a binder round-trip.
            val latch = CountDownLatch(1)
            connectLatch = latch
            VerificationSlot.set { result ->
                lastResultRef.set(result)
                latch.countDown()
            }

            // --- Launch the VPN service with ACTION_CONNECT --------------------
            val serviceIntent = Intent(context, DistortVpnService::class.java).apply {
                action = DistortVpnService.ACTION_CONNECT
                putExtra("config_uri", configUri)
                putExtra("protocol", scheme)
            }
            // startForegroundService() requires the service to call startForeground()
            // within ~5s; DistortVpnService.showNotification() does this immediately
            // in startVpn(). androidx.core.content.ContextCompat handles the
            // API-level dispatch (startForegroundService on API 26+, startService below).
            androidx.core.content.ContextCompat.startForegroundService(context, serviceIntent)

            // --- Block the calling (binder) thread until verification completes
            val started = System.currentTimeMillis()
            val awaited = latch.await(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
            val latency = (System.currentTimeMillis() - started).toInt()

            // Clear the slot (one-shot)
            VerificationSlot.clear()
            connectLatch = null

            if (!awaited) {
                // Timed out — the verification thread hasn't called back.
                // Best-effort stop the half-started service so we don't leave
                // a zombie TUN interface.
                Log.w(TAG, "connect() timed out after ${timeoutMs}ms — stopping service")
                disconnectInternal(waitForStop = false, timeoutMs = 1000)
                return failResult("Connection timed out after ${timeoutMs}ms").copy(latencyMs = latency).toJson()
            }

            val result = lastResultRef.get()
                ?: return failResult("Verification completed with no result").copy(latencyMs = latency).toJson()

            Log.i(
                TAG,
                "connect() done — started=${result.started} verified=${result.trafficVerified} " +
                    "exitIp=${result.exitIp} latencyMs=${result.latencyMs ?: latency} " +
                    "error=${result.error ?: "null"}"
            )

            // If the service didn't report latency, fill it in from our wall-clock.
            return result.copy(latencyMs = result.latencyMs ?: latency).toJson()
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            return failResult("Connection interrupted: ${e.message}").toJson()
        } catch (e: Exception) {
            Log.e(TAG, "connect() failed", e)
            return failResult("Android bridge call failed: ${e.message ?: e.javaClass.simpleName}").toJson()
        }
    }

    /**
     * Stop the currently-running tunnel. Returns true if a stop signal was
     * sent (even if the service had already exited).
     */
    @JavascriptInterface
    fun disconnect(): Boolean {
        return try {
            disconnectInternal(waitForStop = true, timeoutMs = 2000)
        } catch (e: Exception) {
            Log.e(TAG, "disconnect() failed", e)
            false
        }
    }

    /**
     * Live status — does NOT block. Reads the SharedPreferences flag that
     * DistortVpnService writes after successful traffic verification.
     */
    @JavascriptInterface
    fun isRunning(): Boolean {
        return try {
            val prefs = context.getSharedPreferences("distort", Context.MODE_PRIVATE)
            prefs.getBoolean("vpn_service_running", false)
        } catch (e: Exception) {
            Log.w(TAG, "isRunning() failed: ${e.message}")
            false
        }
    }

    /**
     * Current exit IP (or empty string if not connected / not verified).
     * Read from SharedPreferences — DistortVpnService writes vpn_exit_ip
     * only on successful verification.
     */
    @JavascriptInterface
    fun getExitIp(): String {
        return try {
            val prefs = context.getSharedPreferences("distort", Context.MODE_PRIVATE)
            // Only return a non-empty IP if BOTH the service is running AND
            // traffic was verified (vpn_connected=true). Otherwise return "".
            if (prefs.getBoolean("vpn_connected", false)) {
                prefs.getString("vpn_exit_ip", "") ?: ""
            } else {
                ""
            }
        } catch (e: Exception) {
            ""
        }
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    private fun disconnectInternal(waitForStop: Boolean, timeoutMs: Int): Boolean {
        return try {
            val stopIntent = Intent(context, DistortVpnService::class.java).apply {
                action = DistortVpnService.ACTION_DISCONNECT
            }
            context.startService(stopIntent)
            if (waitForStop) {
                // Poll SharedPreferences until vpn_service_running flips false
                val deadline = System.currentTimeMillis() + timeoutMs
                while (System.currentTimeMillis() < deadline) {
                    val prefs = context.getSharedPreferences("distort", Context.MODE_PRIVATE)
                    if (!prefs.getBoolean("vpn_service_running", false)) return true
                    Thread.sleep(100)
                }
                Log.w(TAG, "disconnect(): service did not stop within ${timeoutMs}ms")
                false
            } else {
                true
            }
        } catch (e: Exception) {
            Log.e(TAG, "disconnectInternal failed", e)
            false
        }
    }

    private fun failResult(reason: String): ConnectResult {
        return ConnectResult(
            started = false,
            trafficVerified = false,
            exitIp = null,
            realIp = null,
            error = reason,
            latencyMs = null
        )
    }

    // -------------------------------------------------------------------------
    // Result data class — serialized to JSON via org.json
    // -------------------------------------------------------------------------

    // NOTE: ConnectResult is public (not internal) because VerificationSlot.set()
    // exposes it via a public callback parameter. Kotlin requires that public
    // functions don't expose internal types.
    data class ConnectResult(
        val started: Boolean,
        val trafficVerified: Boolean,
        val exitIp: String?,
        val realIp: String?,
        val error: String?,
        val latencyMs: Int?
    ) {
        fun toJson(): String {
            val obj = org.json.JSONObject()
            obj.put("started", started)
            obj.put("trafficVerified", trafficVerified)
            obj.put("exitIp", exitIp ?: org.json.JSONObject.NULL)
            obj.put("realIp", realIp ?: org.json.JSONObject.NULL)
            obj.put("error", error ?: org.json.JSONObject.NULL)
            obj.put("latencyMs", latencyMs ?: org.json.JSONObject.NULL)
            return obj.toString()
        }
    }

    // -------------------------------------------------------------------------
    // Verification slot — a tiny static bridge so DistortVpnService can
    // report verification results back to RecoveryBridge without needing
    // a direct reference (the service is started via Intent, not bound).
    //
    // DistortVpnService should call VerificationSlot.report(result) right
    // after verifyTrafficThroughProxy() completes.
    // -------------------------------------------------------------------------

    companion object VerificationSlot {
        @Volatile
        private var callback: ((ConnectResult) -> Unit)? = null

        fun set(cb: (ConnectResult) -> Unit) {
            callback = cb
        }

        fun clear() {
            callback = null
        }

        /**
         * Called by DistortVpnService when verifyTrafficThroughProxy finishes.
         * Safe to call from any thread.
         */
        @JvmStatic
        fun report(started: Boolean, trafficVerified: Boolean, exitIp: String?, realIp: String?, error: String?, latencyMs: Int?) {
            try {
                callback?.invoke(
                    ConnectResult(started, trafficVerified, exitIp, realIp, error, latencyMs)
                )
            } catch (e: Exception) {
                Log.w("DistortBridge", "VerificationSlot.report() failed: ${e.message}")
            }
        }
    }
}
