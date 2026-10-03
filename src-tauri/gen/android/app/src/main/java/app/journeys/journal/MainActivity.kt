package app.journeys.journal

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // From Android 15 the app draws under the system bars and a keyboard no longer
    // shrinks it, and the WebView tells CSS about neither (`env(safe-area-inset-bottom)`
    // read 0 over the gesture bar). So the page is laid out between the bars and above
    // the keyboard; behind the bars is this view, painted by `PhonePlugin.paint`.
    ViewCompat.setOnApplyWindowInsetsListener(findViewById<View>(android.R.id.content)) { view, insets ->
      val edge = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      view.setPadding(edge.left, edge.top, edge.right, edge.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
