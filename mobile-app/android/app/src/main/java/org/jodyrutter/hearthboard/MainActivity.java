package org.jodyrutter.hearthboard;

import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);

        if (getBridge() != null && getBridge().getWebView() != null) {
            cookieManager.setAcceptThirdPartyCookies(getBridge().getWebView(), true);

            WebSettings settings = getBridge().getWebView().getSettings();
            settings.setDomStorageEnabled(true);
        }
    }
}
