package org.jodyrutter.hearthboard;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        this.config = buildLauncherConfig();
        super.onCreate(savedInstanceState);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);

        if (getBridge() != null && getBridge().getWebView() != null) {
            cookieManager.setAcceptThirdPartyCookies(getBridge().getWebView(), true);

            WebSettings settings = getBridge().getWebView().getSettings();
            settings.setDomStorageEnabled(true);
        }
    }

    private com.getcapacitor.CapConfig buildLauncherConfig() {
        String preferredRoute = determinePreferredRoute();
        String[] allowNavigationHosts = new String[] {
            "192.168.1.118",
            "jodyrutter-sh.duckdns.org"
        };

        return new com.getcapacitor.CapConfig.Builder(this)
            .setStartPath("/?preferredRoute=" + preferredRoute)
            .setAllowNavigation(allowNavigationHosts)
            .setAppendedUserAgentString(" HearthboardAndroidApp/1.0")
            .create();
    }

    private String determinePreferredRoute() {
        ConnectivityManager connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivityManager != null) {
            Network activeNetwork = connectivityManager.getActiveNetwork();
            if (activeNetwork != null) {
                NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(activeNetwork);
                if (capabilities != null) {
                    if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
                        return "local";
                    }
                }
            }
        }

        return "remote";
    }
}
