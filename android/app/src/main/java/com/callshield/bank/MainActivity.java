package com.callshield.bank;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * CallShield Bank: the customer's phone app. A WebView hosting the bank's app page (frontend/app.html), which
 * enrols the customer's voice and places calls to the bank over WebRTC. This activity only supplies what a
 * browser tab can't: the microphone permission, a kept-awake screen and a configurable server address.
 *
 * Server address: http://localhost:8000/app.html by default (with `adb reverse tcp:8000 tcp:8000`). Change it
 * from the error screen, or with: adb shell am start -n com.callshield.bank/.MainActivity -e url https://…/app.html
 */
public class MainActivity extends Activity {
    private static final String DEFAULT_URL = "http://localhost:8000/app.html";
    private static final String PREFS = "callshield";
    private static final String KEY_URL = "url";
    private static final int REQ_MIC = 1;
    private static final int BG = 0xFF0B0D12;  // the app page's background (base.css --bg)

    private WebView web;
    private PermissionRequest pendingMic;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Calls happen on this screen: don't let the phone lock mid-call.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(BG);  // no white flash before the page paints
        setContentView(web);
        darkSystemBars();  // after setContentView: the insets controller needs the decor view
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handleWebPermission(request));
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("callshield".equals(u.getScheme())) {  // from the error page's "Connect" form
                    String url = u.getQueryParameter("u");
                    if (!TextUtils.isEmpty(url)) { saveUrl(url); view.loadUrl(url); }
                    return true;
                }
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showOffline(String.valueOf(error.getDescription()));
            }
        });

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
        }
        applyIntentUrl(getIntent());
        web.loadUrl(serverUrl());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (applyIntentUrl(intent)) web.loadUrl(serverUrl());
    }

    /** Status and navigation bars in the page's background colour, with light icons. */
    private void darkSystemBars() {
        Window w = getWindow();
        w.setBackgroundDrawable(new ColorDrawable(BG));
        w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        w.setStatusBarColor(BG);
        w.setNavigationBarColor(BG);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                c.setSystemBarsAppearance(0, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
            }
        } else {
            View d = w.getDecorView();
            d.setSystemUiVisibility(d.getSystemUiVisibility()
                    & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
    }

    private boolean applyIntentUrl(Intent intent) {
        String url = intent == null ? null : intent.getStringExtra("url");
        if (TextUtils.isEmpty(url)) return false;
        saveUrl(url);
        return true;
    }

    private String serverUrl() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, DEFAULT_URL);
    }

    private void saveUrl(String url) {
        SharedPreferences.Editor e = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
        e.putString(KEY_URL, url);
        e.apply();
    }

    /** The page asked for the mic (getUserMedia): grant audio only, after the Android permission is granted. */
    private void handleWebPermission(PermissionRequest request) {
        boolean wantsAudio = false;
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsAudio = true;
        }
        if (!wantsAudio) { request.deny(); return; }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            pendingMic = request;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQ_MIC || pendingMic == null) return;
        boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (ok) pendingMic.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        else pendingMic.deny();
        pendingMic = null;
    }

    private void showOffline(String why) {
        String url = TextUtils.htmlEncode(serverUrl());
        String html = "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>*{box-sizing:border-box}body{margin:0;padding:32px 20px;background:#0b0d12;color:#e8ebf2;"
                + "font:16px/1.5 system-ui,Roboto,sans-serif}svg{width:48px;height:48px;margin-bottom:20px}"
                + "h1{margin:0 0 8px;font-size:1.5rem;letter-spacing:-.02em}.m{color:#8d95a8;margin:0 0 28px}"
                + "label{display:block;margin-bottom:8px;color:#8d95a8;font-size:.75rem;font-weight:600;"
                + "letter-spacing:.08em;text-transform:uppercase}input{width:100%;height:52px;padding:0 14px;"
                + "background:#181c25;border:1px solid #2f3646;border-radius:14px;color:#e8ebf2;font-size:16px}"
                + "input:focus{outline:none;border-color:#d4ff2a}button{width:100%;height:56px;margin-top:16px;"
                + "border:0;border-radius:16px;background:#d4ff2a;color:#0b0d12;font-size:1.05rem;font-weight:600}"
                + ".h{margin-top:28px;color:#5e6578;font-size:.88rem}code{color:#8d95a8}</style>"
                + "<body><svg viewBox='0 0 32 32'><path d='M16 2.5l11 4v8.2c0 6.6-4.6 12.2-11 14.3C9.6 26.9 5 21.3 5 14.7V6.5l11-4z' fill='#d4ff2a'/>"
                + "<path d='M9.5 16h2.5l1.6-4 2.6 8 2.3-6 1.3 2h2.7' fill='none' stroke='#0f1115' stroke-width='2.2' "
                + "stroke-linecap='round' stroke-linejoin='round'/></svg>"
                + "<h1>Can't reach the bank</h1><p class='m'>" + TextUtils.htmlEncode(why) + "</p>"
                + "<form action='callshield://connect'><label for='u'>Server address</label>"
                + "<input id='u' name='u' value='" + url + "' inputmode='url' autocomplete='off'>"
                + "<button>Connect</button></form>"
                + "<p class='h'>On USB: run <code>adb reverse tcp:8000 tcp:8000</code> on the laptop.</p></body>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
