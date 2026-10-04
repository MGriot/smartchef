package com.smartchef.app;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// ════════════════════════════════════════════════════════════════════════
// SmartChef — Print plugin
// App-specific Capacitor plugin that gives the Android app the printing
// window.print() pretends to: the WebView exposes window.print as a real
// function that does nothing, because Android prints through the framework
// PrintManager, which a WebView does not wire up on its own. See
// frontend/src/lib/print.ts for the JS side and why it matters.
//
// It prints the app's OWN WebView — the page that is on screen — rather
// than loading the content into a fresh offscreen one. Two reasons:
//   - the report route's @media print CSS is already applied by that page,
//     so what prints is what the preview showed;
//   - local recipe photos load through Capacitor's _capacitor_file_ request
//     interceptor, which only the bridge WebView has. A WebView created
//     here would print every local image as a broken box.
//
// The system print dialog this opens offers "Save as PDF" as a destination
// next to the real printers, so this one call covers both. The job name
// is what that destination proposes as the PDF's filename.
// ════════════════════════════════════════════════════════════════════════

@CapacitorPlugin(name = "SmartChefPrint")
public class SmartChefPrintPlugin extends Plugin {

    @PluginMethod
    public void print(PluginCall call) {
        String requested = call.getString("jobName", "SmartChef");
        final String jobName = requested == null || requested.trim().isEmpty() ? "SmartChef" : requested.trim();

        // createPrintDocumentAdapter() and PrintManager.print() both have to
        // run on the UI thread; plugin methods arrive on the bridge's own.
        getActivity().runOnUiThread(() -> {
            try {
                PrintManager printManager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                WebView webView = getBridge().getWebView();
                if (printManager == null || webView == null) {
                    call.reject("Printing is not available on this device");
                    return;
                }
                PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(jobName);
                PrintAttributes attributes = new PrintAttributes.Builder()
                    .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                    .build();
                printManager.print(jobName, adapter, attributes);
                // Resolves once the dialog is up, not when the job finishes:
                // the dialog owns the rest, and nothing on the JS side waits
                // on whether the user printed, saved or backed out.
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not start printing: " + e.getMessage(), e);
            }
        });
    }
}
