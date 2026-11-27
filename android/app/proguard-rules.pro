# The web app calls these through window.NanotesAndroidUpdater; the install result comes back by broadcast.
-keepclassmembers class moe.quill.nanotes.AndroidUpdater {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class moe.quill.nanotes.InstallResultReceiver { *; }
