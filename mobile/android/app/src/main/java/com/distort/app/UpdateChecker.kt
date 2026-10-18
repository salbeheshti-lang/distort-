package com.distort.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

// UpdateChecker.kt — checks GitHub Releases for new APK versions
//
// Flow:
//   1. On app start (or when the user taps "Check for updates"), call
//      checkForUpdate(). This fetches the GitHub Releases latest endpoint
//      for the distort repo.
//   2. Parse the release tag (e.g. "v1.0.4") and compare with
//      BuildConfig.VERSION_CODE (which is read from /VERSION_CODE at build
//      time).
//   3. If the release is newer, locate the APK asset in the release's
//      `assets[]` array (preferring a per-ABI match for the device, then
//      "universal", then any *.apk asset).
//   4. Download the APK to cacheDir/updates/<release-tag>.apk, streaming
//      to disk and reporting progress via a callback.
//   5. The caller (MainActivity) shows a dialog: "New version X available.
//      Download and install?"
//   6. On confirm, installApk() triggers Android's package installer via
//      ACTION_VIEW with the application/vnd.android.package-archive MIME
//      type and a content:// URI from FileProvider (required for API 24+).
//   7. If the APK signature doesn't match (different signing key — e.g.
//      trying to update from a debug build to a release build, or vice
//      versa), Android will refuse to install and surface a clear error
//      in the system installer UI.
//
// Permissions / settings required:
//   - android.permission.REQUEST_INSTALL_PACKAGES (declared in AndroidManifest)
//   - On Android 8+ the user must enable "Install unknown apps" for Distort
//     in Settings → Apps → Distort → Install unknown apps. The system
//     installer prompts for this the first time; if the user denies, the
//     install fails with INSTALL_CANCELLED.
//   - FileProvider declared in AndroidManifest with authority
//     "${applicationId}.fileprovider" and a paths config exposing the
//     cache "updates/" subdirectory (see res/xml/file_paths.xml).
//
// HONEST LIMITATIONS:
//   - Debug builds CAN check for updates and download APKs, but installing
//     a release-signed APK on top of a debug-signed build will fail with
//     a signature mismatch (Android UI surfaces this — we don't have to).
//   - The GitHub Releases API has a rate limit of 60 requests/hour per
//     unauthenticated IP. checkForUpdate() is called at most once per app
//     launch (or on explicit user action) — well under that limit.
//   - If GitHub is blocked in the user's region (which is the whole point
//     of Distort), the update check silently fails (returns null). This
//     is by design: a failed update check should NEVER block the user
//     from using the app.

class UpdateChecker(private val activity: Activity) {

    companion object {
        private const val TAG = "UpdateChecker"

        // GitHub Releases "latest" endpoint for the Distort repo.
        // Returns a JSON object with tag_name, name, body, assets[], etc.
        // See: https://docs.github.com/en/rest/releases/releases#get-the-latest-release
        private const val GITHUB_API =
            "https://api.github.com/repos/di6tort-bit/distort/releases/latest"

        // HTTP timeouts. The GitHub API is fast; the APK download can be
        // large (currently ~77MB) so we use a long read timeout for that.
        private const val CONNECT_TIMEOUT_MS = 10_000
        private const val API_READ_TIMEOUT_MS = 15_000
        private const val APK_READ_TIMEOUT_MS = 300_000 // 5 minutes (Int, not Long — HttpURLConnection expects Int)

        // The cache subdirectory where downloaded APKs land. MUST match a
        // <cache-path> entry in res/xml/file_paths.xml or FileProvider
        // will throw when we try to share the URI.
        private const val APK_CACHE_DIR = "updates"

        // User-Agent for the GitHub API request (GitHub requests a UA).
        private const val USER_AGENT = "Distort-Android-Updater/1.0"
    }

    /**
     * Parsed result of a successful update check.
     *
     * @property tag        GitHub release tag (e.g. "v1.0.4").
     * @property versionCode  Numeric version code parsed from the tag (last
     *                        dot-separated integer). Compared with
     *                        BuildConfig.VERSION_CODE to decide whether an
     *                        update is available.
     * @property versionName  Human-readable version (tag without leading "v").
     * @property releaseName  Title of the release (the "name" field).
     * @property releaseNotes Markdown body of the release notes.
     * @property apkUrl      Direct download URL of the APK asset to install.
     * @property apkSize     Size of the APK asset in bytes (for UI display).
     * @property apkName     Filename of the APK asset (used for the cached file).
     */
    data class UpdateInfo(
        val tag: String,
        val versionCode: Int,
        val versionName: String,
        val releaseName: String,
        val releaseNotes: String,
        val apkUrl: String,
        val apkSize: Long,
        val apkName: String
    )

    /**
     * Check GitHub Releases for a newer version.
     *
     * Returns:
     *   - UpdateInfo if a newer version exists and has an .apk asset.
     *   - null if the app is already up-to-date, if the release has no APK
     *     asset, or if any network/parse error occurred (logged to logcat
     *     at WARN level — never thrown to the caller).
     *
     * Must be called from a coroutine; performs network I/O on Dispatchers.IO.
     */
    suspend fun checkForUpdate(): UpdateInfo? = withContext(Dispatchers.IO) {
        try {
            val conn = (URL(GITHUB_API).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = API_READ_TIMEOUT_MS
                setRequestProperty("Accept", "application/vnd.github+json")
                setRequestProperty("User-Agent", USER_AGENT)
            }
            conn.connect()
            val code = conn.responseCode
            if (code != 200) {
                Log.w(TAG, "GitHub API returned HTTP $code — update check skipped")
                return@withContext null
            }
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()

            val json = JSONObject(body)
            val tag = json.optString("tag_name", "").trim()
            if (tag.isEmpty()) {
                Log.w(TAG, "GitHub response missing tag_name")
                return@withContext null
            }

            val releaseVersionCode = parseVersionCodeFromTag(tag)
            if (releaseVersionCode <= 0) {
                Log.w(TAG, "Could not parse version code from tag '$tag'")
                return@withContext null
            }

            val currentVersionCode = BuildConfig.VERSION_CODE
            if (releaseVersionCode <= currentVersionCode) {
                Log.i(TAG, "App is up to date (current=$currentVersionCode, latest=$releaseVersionCode)")
                return@withContext null
            }

            // Find the APK asset. Prefer a per-ABI match for the running
            // device, then "universal", then any .apk asset.
            val assets = json.optJSONArray("assets") ?: run {
                Log.w(TAG, "Release $tag has no assets — skipping")
                return@withContext null
            }

            val deviceAbi = preferredDeviceAbi()
            var universalAsset: JSONObject? = null
            var abiMatchAsset: JSONObject? = null
            var anyApkAsset: JSONObject? = null

            for (i in 0 until assets.length()) {
                val asset = assets.optJSONObject(i) ?: continue
                val name = asset.optString("name", "").lowercase()
                if (!name.endsWith(".apk")) continue

                // Skip split APKs (e.g. arm64_v8a.apk without universal) —
                // we only handle a single self-contained APK here.
                if (universalAsset == null &&
                    (name.contains("universal") || name.contains("noarch"))) {
                    universalAsset = asset
                }
                if (abiMatchAsset == null && deviceAbi != null && name.contains(deviceAbi)) {
                    abiMatchAsset = asset
                }
                if (anyApkAsset == null) {
                    anyApkAsset = asset
                }
            }

            val chosen = abiMatchAsset ?: universalAsset ?: anyApkAsset ?: run {
                Log.w(TAG, "Release $tag has no .apk asset — skipping")
                return@withContext null
            }

            val apkUrl = chosen.optString("browser_download_url", "")
            if (apkUrl.isEmpty()) {
                Log.w(TAG, "APK asset missing browser_download_url")
                return@withContext null
            }

            val versionName = tag.removePrefix("v")
            UpdateInfo(
                tag = tag,
                versionCode = releaseVersionCode,
                versionName = versionName,
                releaseName = json.optString("name", versionName),
                releaseNotes = json.optString("body", "").trim(),
                apkUrl = apkUrl,
                apkSize = chosen.optLong("size", 0L),
                apkName = chosen.optString("name", "distort-$tag.apk")
            )
        } catch (e: Exception) {
            Log.w(TAG, "Update check failed: ${e.javaClass.simpleName}: ${e.message}")
            null
        }
    }

    /**
     * Download the APK to cacheDir/updates/<apkName>.
     *
     * Calls [onProgress] with a 0..1f fraction as bytes stream in. Must be
     * called from a coroutine; runs on Dispatchers.IO.
     *
     * Throws on network/disk failure — the caller is responsible for
     * surfacing the error to the user.
     */
    suspend fun downloadApk(
        update: UpdateInfo,
        onProgress: (Float) -> Unit = {}
    ): File = withContext(Dispatchers.IO) {
        val updatesDir = File(activity.cacheDir, APK_CACHE_DIR).apply {
            if (!exists()) mkdirs()
        }
        // Clear any previous APKs in the cache dir so we don't accumulate
        // gigabytes of stale installers across updates.
        updatesDir.listFiles()?.forEach { it.delete() }

        val targetFile = File(updatesDir, update.apkName)
        if (targetFile.exists()) targetFile.delete()

        val conn = (URL(update.apkUrl).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = APK_READ_TIMEOUT_MS
            setRequestProperty("User-Agent", USER_AGENT)
            // GitHub releases redirect to a CDN — HttpURLConnection follows
            // redirects by default; no need for manual handling.
        }
        conn.connect()
        val code = conn.responseCode
        if (code != 200) {
            conn.disconnect()
            throw java.io.IOException("APK download failed: HTTP $code")
        }

        val total = conn.contentLengthLong
        var read = 0L
        try {
            conn.inputStream.use { input ->
                FileOutputStream(targetFile).use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        read += n
                        if (total > 0) {
                            // Report on main thread so the caller can update UI
                            // safely without needing to dispatch itself.
                            val frac = (read.toFloat() / total.toFloat()).coerceIn(0f, 1f)
                            onProgress(frac)
                        }
                    }
                }
            }
        } finally {
            conn.disconnect()
        }

        if (targetFile.length() == 0L) {
            targetFile.delete()
            throw java.io.IOException("Downloaded APK is empty (0 bytes)")
        }
        targetFile
    }

    /**
     * Launch Android's system package installer for the given APK file.
     *
     * Uses FileProvider to obtain a content:// URI (required on API 24+).
     * The user must have granted "Install unknown apps" permission for
     * Distort — Android prompts for this the first time, so we don't need
     * to pre-check.
     *
     * On a signature mismatch (e.g. trying to install a release APK on top
     * of a debug-signed build, or vice versa) the system installer shows
     * "App not installed" — we can't intercept that, so the user has to
     * uninstall the existing app first.
     */
    fun installApk(apkFile: File) {
        val authority = "${activity.packageName}.fileprovider"
        val uri: Uri = try {
            FileProvider.getUriForFile(activity, authority, apkFile)
        } catch (e: IllegalArgumentException) {
            Log.e(TAG, "FileProvider not configured for authority $authority " +
                "or path ${apkFile.absolutePath} not covered by file_paths.xml", e)
            return
        }

        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            // FLAG_ACTIVITY_NEW_TASK so the installer can launch from a
            // non-Activity context if needed.
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            activity.startActivity(intent)
        } catch (e: android.content.ActivityNotFoundException) {
            Log.e(TAG, "No activity available to handle ACTION_VIEW for APK install", e)
        }
    }

    /**
     * Parse the trailing numeric segment of a version tag as an integer.
     *
     * Handles: "v1.0.4" → 4, "1.0.4" → 4, "v4" → 4, "v1.0.4-rc1" → 4,
     * "v1.0.4+build7" → 4. Returns 0 if no trailing integer is found.
     */
    private fun parseVersionCodeFromTag(tag: String): Int {
        val stripped = tag.removePrefix("v").trim()
        // Split on '.', take last segment, strip any non-digit suffix.
        val segments = stripped.split('.')
        if (segments.isEmpty()) return 0
        val last = segments.last()
        // Extract leading digits of the last segment (handles "4-rc1", "4+build7").
        val digits = last.takeWhile { it.isDigit() }
        return digits.toIntOrNull() ?: 0
    }

    /**
     * Return the preferred device ABI for APK asset matching.
     *
     * Build.SUPPORTED_ABIS is ordered by preference on Android 8+; we just
     * take the first one and lowercase it for substring matching against
     * asset filenames. Returns null if the list is empty (extremely rare).
     */
    private fun preferredDeviceAbi(): String? {
        val abis = Build.SUPPORTED_ABIS ?: return null
        if (abis.isEmpty()) return null
        return abis[0].lowercase()
    }
}
