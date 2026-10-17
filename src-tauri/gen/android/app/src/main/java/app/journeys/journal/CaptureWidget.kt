package app.journeys.journal

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/**
 * The home screen's "Add to today": a bar that opens Journeys on its + sheet's note,
 * the keyboard up, so a line goes into today from the home screen. The page writes it,
 * as it writes every other (`PhonePlugin` says the bar was pressed).
 */
class CaptureWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val open = PendingIntent.getActivity(
            context,
            0,
            // Handed to the running app each time, not only the first: launched the same
            // way again, Android brought its task forward and said nothing to it.
            Intent(context, MainActivity::class.java)
                .setAction(CAPTURE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val views = RemoteViews(context.packageName, R.layout.widget_capture).apply { setOnClickPendingIntent(R.id.widget_capture, open) }
        ids.forEach { manager.updateAppWidget(it, views) }
    }

    companion object {
        const val CAPTURE = "app.journeys.journal.CAPTURE"
    }
}
