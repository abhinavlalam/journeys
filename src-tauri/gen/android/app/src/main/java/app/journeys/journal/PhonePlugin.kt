package app.journeys.journal

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.provider.OpenableColumns
import android.view.View
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.core.view.WindowCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.util.concurrent.Executors

@InvokeArg
class PaintArgs {
    var color: String = ""
    var light: Boolean = false
}

/**
 * What the phone adds (`phone.rs` is the Rust half): what other apps share in through
 * Android's share sheet, and the colour behind the system bars.
 *
 * A share's files are copied into the app's own files as it arrives, while the
 * sender's grant to read them lasts; the page moves the copies into the vault as it
 * files the share. Not the cache: a file moved out of it keeps the cache's group, and
 * Android counted the vault's photos as cache. The copying is off the main thread, and `take` runs on the same thread after
 * it, so a share is never taken half copied.
 */
@TauriPlugin
class PhonePlugin(private val activity: Activity) : Plugin(activity) {
    private val worker = Executors.newSingleThreadExecutor()
    /** Touched on `worker` only. */
    private val waiting = mutableListOf<JSObject>()

    override fun load(webView: WebView) = receive(activity.intent)

    override fun onNewIntent(intent: Intent) = receive(intent)

    private fun receive(intent: Intent?) {
        if (intent == null || intent.action !in listOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)) return
        // Reopened from Recents, the activity is handed the share it was opened with again.
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        val at = System.currentTimeMillis()
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
        val streams = streamsOf(intent)
        worker.execute {
            val files = JSArray()
            streams.forEachIndexed { index, uri -> files.put(copy(uri, "$at-$index", intent.type)) }
            waiting.add(JSObject().apply {
                put("at", at)
                put("text", text)
                put("subject", subject)
                put("files", files)
            })
        }
    }

    @Suppress("DEPRECATION")
    private fun streamsOf(intent: Intent): List<Uri> =
        if (intent.action == Intent.ACTION_SEND_MULTIPLE) intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
        else listOfNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM))

    /** The copy's path and the file's own name, or why it could not be read. */
    private fun copy(uri: Uri, key: String, type: String?): JSObject {
        val name = nameOf(uri, type)
        val into = File(activity.filesDir, "shared/$key")
        return JSObject().apply {
            put("name", name)
            try {
                into.parentFile?.mkdirs()
                val input = activity.contentResolver.openInputStream(uri) ?: throw IllegalStateException("the sending app gave nothing to read")
                input.use { from -> into.outputStream().use { from.copyTo(it) } }
                put("path", into.absolutePath)
            } catch (err: Exception) {
                put("error", err.message ?: err.toString())
            }
        }
    }

    /**
     * The name the sender gives, with an extension from its type when the name has
     * none: the file's own type, else the share's, as a refused query gives neither name nor type.
     */
    private fun nameOf(uri: Uri, shared: String?): String {
        val given = try {
            activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { if (it.moveToFirst()) it.getString(0) else null }
        } catch (_: Exception) {
            null
        } ?: uri.lastPathSegment ?: "shared"
        if (given.contains('.')) return given
        val type = try { activity.contentResolver.getType(uri) } catch (_: Exception) { null } ?: shared
        val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(type)
        return if (extension == null) given else "$given.$extension"
    }

    @Command
    fun take(invoke: Invoke) {
        worker.execute {
            val shares = JSArray()
            waiting.forEach(shares::put)
            waiting.clear()
            invoke.resolve(JSObject().apply { put("shares", shares) })
        }
    }

    /**
     * The page is laid out between the system bars (`MainActivity`), so what shows
     * behind them is this view: painted the page's colour, with icons that read on it.
     */
    @Command
    fun paint(invoke: Invoke) {
        val args = invoke.parseArgs(PaintArgs::class.java)
        activity.runOnUiThread {
            try {
                activity.findViewById<View>(android.R.id.content).setBackgroundColor(Color.parseColor(args.color))
                WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply {
                    isAppearanceLightStatusBars = args.light
                    isAppearanceLightNavigationBars = args.light
                }
                invoke.resolve()
            } catch (err: Exception) {
                invoke.reject(err.message ?: err.toString())
            }
        }
    }
}
