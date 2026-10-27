package com.egebulut.opencommunicate;

import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.net.Uri;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * An image on the clipboard (a screenshot, an image copied in another app), for the message being written. The
 * WebView's text box offers no Paste for one, and the page may not read the clipboard itself.
 */
@CapacitorPlugin(name = "ClipboardImage")
public class ClipboardImagePlugin extends Plugin {

    private ClipboardManager clipboard() {
        return getContext().getSystemService(ClipboardManager.class);
    }

    /** Whether the clipboard holds an image, from its description: reading the clip itself makes Android say so. */
    @PluginMethod
    public void has(PluginCall call) {
        ClipDescription d = clipboard().getPrimaryClipDescription();
        call.resolve(new JSObject().put("image", d != null && d.hasMimeType("image/*")));
    }

    /** The clipboard's image, as its type and its bytes in base64; nothing when it holds none. */
    @PluginMethod
    public void read(PluginCall call) {
        ClipData clip = clipboard().getPrimaryClip();
        for (int i = 0; clip != null && i < clip.getItemCount(); i++) {
            Uri uri = clip.getItemAt(i).getUri();
            String type = uri == null ? null : getContext().getContentResolver().getType(uri);
            if (type == null || !type.startsWith("image/")) continue;
            try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[65536];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                call.resolve(new JSObject().put("type", type).put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)));
            } catch (Exception e) {
                call.reject("Could not read the copied image: " + e.getMessage());
            }
            return;
        }
        call.resolve(new JSObject());
    }
}
