package com.egebulut.opencommunicate;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Base64;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * New messages while the app is closed. The app's page notifies for the open chat while it runs; Android stops it
 * soon after the app leaves the screen, and nothing told the person about a message after that. This job runs
 * about every 15 minutes (Android's shortest period), reads the chats and tokens the page keeps in its files
 * (oc-session.json, oc-auth.json, see app/src/session.ts) and notifies the way the page does.
 *
 * It takes over where the page stopped: the page records the head it has notified up to (oc-heads.json), this job
 * its own (oc-bg.json), and the newer of the two is where it starts, so a message is notified once. While the page
 * is alive (the app is open or in the background) it leaves the page's open chat to the page and renews no token.
 *
 * GitHub refuses a refresh token used twice, and the page then asks to sign in again, so the two never renew at
 * once: the job renews only while the page is not alive, says so first in oc-renewing.json (the page waits while
 * it is there, see renewCred in session.ts), and keeps what it gets in a file of its own, oc-auth-bg.json, which
 * the page reads with oc-auth.json, the newer token of an account winning. Each file has one writer.
 */
public class MessageCheck extends JobService {
    private static final String TAG = "MessageCheck";
    private static final int JOB_ID = 7001;
    private static final String CLIENT_ID = "Ov23liPuqrEbse9N4sDQ";
    private static final String CHANNEL = "default"; // the notification plugin's channel: one setting for every message notice
    private static final Pattern MESSAGE = Pattern.compile("^channels/([a-z0-9-]+)/\\d{8}T\\d{9}Z-\\d{4}-[a-z0-9]{6}\\.json$");
    private static final Pattern DM = Pattern.compile("^dm-\\d{4}-\\d{4}$");
    private static final int MAX_NOTICES = 10; // per run; more than that is a backlog, the app shows the rest

    /** Called as the app starts; a background check that can't be scheduled must not stop the app. */
    static void schedule(Context c) {
        try {
            JobScheduler js = c.getSystemService(JobScheduler.class);
            if (js == null || js.getPendingJob(JOB_ID) != null) return;
            js.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(c, MessageCheck.class))
                .setPeriodic(15 * 60_000L)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build());
        } catch (RuntimeException e) { Log.w(TAG, "could not schedule", e); }
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            try { check(); } catch (Exception e) { Log.w(TAG, "check failed", e); }
            finally { jobFinished(params, false); }
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) { return false; } // the next period tries again

    // ---------- the check ----------

    private String api = "https://api.github.com", oauth = "https://github.com";

    private void check() throws IOException, JSONException {
        // a test points the job at a fake GitHub (adb shell run-as … ; nothing else can write the app's files)
        String dev = read("oc-dev-api.txt");
        if (dev != null && !dev.trim().isEmpty()) api = oauth = dev.trim();
        JSONObject chats = json(read("oc-session.json"));
        if (chats == null) return;
        boolean alive = MainActivity.alive;
        if (alive) { try { Thread.sleep(20_000); } catch (InterruptedException e) { return; } } // the page wakes with this job: let it look first
        JSONObject auth = creds();
        JSONObject pageHeads = json(read("oc-heads.json")), own = json(read("oc-bg.json"));
        if (own == null) own = new JSONObject();
        JSONArray list = chats.optJSONArray("chats");
        String active = chats.optString("active", "");
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject s = list.getJSONObject(i);
            String repo = s.getString("repo");
            // the page's open chat is the page's while it is alive, even frozen: its record says how far it got
            if (alive && repo.equalsIgnoreCase(active)) continue;
            try {
                String token = tokenFor(s, auth, alive);
                if (token == null) continue;
                String head = head(repo, token);
                if (head == null) continue;
                String from = newer(own.optJSONObject(repo), pageHeads == null ? null : pageHeads.optJSONObject(repo));
                if (from != null && !from.equals(head) && !notifyNew(s, token, from, head)) continue; // try again next time
                own.put(repo, new JSONObject().put("head", head).put("at", System.currentTimeMillis()));
            } catch (Exception e) { Log.w(TAG, repo + ": " + e.getMessage()); }
        }
        write("oc-bg.json", own.toString());
    }

    /** The head of the two records written last (this job's and the page's), or null when there is none yet. */
    private static String newer(JSONObject a, JSONObject b) {
        if (a == null) return b == null ? null : b.optString("head", null);
        if (b == null) return a.optString("head", null);
        return (b.optLong("at") > a.optLong("at") ? b : a).optString("head", null);
    }

    /** Notifies what arrived between the two heads; false when GitHub's compare view had nothing yet (right after a
     *  push it can leave the new files out), so the same span is looked at again next time. */
    private boolean notifyNew(JSONObject s, String token, String from, String head) throws IOException, JSONException {
        String repo = s.getString("repo");
        JSONObject compare = get("/repos/" + repo + "/compare/" + from + "..." + head, token);
        if (compare == null) return true; // that head is gone: start again from this one
        JSONArray files = compare.optJSONArray("files");
        if (files == null || files.length() == 0) return false;
        JSONObject me = s.getJSONObject("device");
        String id = me.getString("id");
        JSONObject stored = blobAt(repo, "devices/" + id + ".json", head, token); // its notification settings, as the repo has them
        if (stored != null) me = stored;
        Map<String, Boolean> member = new HashMap<>();
        List<JSONObject> found = new ArrayList<>();
        for (int i = 0; i < files.length(); i++) {
            JSONObject f = files.getJSONObject(i);
            Matcher m = MESSAGE.matcher(f.getString("filename"));
            if (!m.matches() || !"added".equals(f.optString("status"))) continue; // an edit or delete rewrites the file: "modified"
            String ch = m.group(1);
            if (!follows(ch, id, repo, head, token, member)) continue;
            JSONObject msg = blob(repo, f.getString("sha"), token);
            if (msg == null || id.equals(msg.optString("from"))) continue;
            JSONObject sys = msg.optJSONObject("system");
            if (sys != null && ("edit".equals(sys.optString("type")) || "delete".equals(sys.optString("type")) || "close".equals(sys.optString("type")))) continue;
            if (!wantsNotice(me, msg)) continue;
            found.add(msg);
        }
        found.sort((a, b) -> a.optString("id").compareTo(b.optString("id")));
        for (JSONObject msg : found.subList(Math.max(0, found.size() - MAX_NOTICES), found.size())) show(msg);
        return true;
    }

    /** #all, this device's DMs, and the groups it is a member of. */
    private boolean follows(String ch, String id, String repo, String head, String token, Map<String, Boolean> member) throws IOException, JSONException {
        if (ch.equals("all")) return true;
        if (DM.matcher(ch).matches()) return ch.substring(3).contains(id);
        if (!ch.startsWith("g-")) return false;
        Boolean in = member.get(ch);
        if (in == null) {
            JSONObject meta = blobAt(repo, "channels/" + ch + "/meta.json", head, token);
            JSONArray members = meta == null ? null : meta.optJSONArray("members");
            in = false;
            for (int i = 0; members != null && i < members.length(); i++) if (id.equals(members.optString(i))) in = true;
            member.put(ch, in);
        }
        return in;
    }

    /** core's wantsNotice: every message, unless the channel is muted, or set to mentions and this isn't one. */
    static boolean wantsNotice(JSONObject me, JSONObject m) {
        JSONObject quiet = me.optJSONObject("quiet");
        JSONObject q = quiet == null ? null : quiet.optJSONObject(m.optString("channel"));
        if (q != null && q.has("until") && q.optString("until").compareTo(iso(System.currentTimeMillis())) <= 0) q = null; // ISO times sort as text
        if (q == null) return true;
        return "mentions".equals(q.optString("mode")) && addressedTo(m, me.optString("nick"), me.optString("id"));
    }

    static String iso(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(ms));
    }

    /** core's addressedTo: a DM, a reply to or quote of one of my messages, or a mention of @nick, nick#id, @all,
     *  @herkes, @everyone (in an encrypted message the words are sealed, so only replies and quotes count). */
    static boolean addressedTo(JSONObject m, String nick, String id) {
        if (DM.matcher(m.optString("channel")).matches()) return true;
        String[] reply = m.optString("replyTo").split("-");
        if (reply.length > 1 && reply[1].equals(id)) return true;
        JSONArray quotes = m.optJSONArray("quotes");
        for (int i = 0; quotes != null && i < quotes.length(); i++) { String[] q = quotes.optString(i).split("-"); if (q.length > 1 && q[1].equals(id)) return true; }
        if (m.has("enc")) return false;
        String n = Pattern.quote(nick);
        return Pattern.compile("(^|[^\\w])(@(" + n + "(#" + id + ")?|all|herkes|everyone)(?![\\w])|" + n + "#" + id + "(?!\\d))", Pattern.CASE_INSENSITIVE)
            .matcher(m.optString("text")).find();
    }

    private void show(JSONObject m) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(this);
        if (!nm.areNotificationsEnabled()) return;
        if (Build.VERSION.SDK_INT >= 26 && getSystemService(NotificationManager.class).getNotificationChannel(CHANNEL) == null)
            getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL, "Default", NotificationManager.IMPORTANCE_DEFAULT));
        // an encrypted message's words stay sealed here: the app shows them when opened
        String text = m.has("enc") ? "🔒" : m.optString("text");
        JSONArray files = m.optJSONArray("files");
        if (text.isEmpty() && files != null && files.length() > 0) text = "📎 " + files.optJSONObject(0).optString("name");
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        try {
            nm.notify(m.optString("id").hashCode(), new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_info) // what the page's notifications show
                .setContentTitle(m.optString("fromNick") + "#" + m.optString("from"))
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(tap)
                .setAutoCancel(true)
                .build());
        } catch (SecurityException e) { Log.w(TAG, "no permission to notify"); }
    }

    // ---------- tokens ----------

    /** Every account's token: oc-auth.json (the page's) and oc-auth-bg.json (this job's), the newer of each account. */
    private JSONObject creds() throws JSONException {
        JSONObject page = json(read("oc-auth.json")), bg = json(read("oc-auth-bg.json"));
        JSONObject out = page == null ? new JSONObject() : page;
        for (java.util.Iterator<String> k = bg == null ? null : bg.keys(); k != null && k.hasNext(); ) {
            String key = k.next();
            JSONObject mine = bg.optJSONObject(key), theirs = out.optJSONObject(key);
            if (theirs != null && mine != null && mine.optLong("at") > theirs.optLong("at")) out.put(key, mine); // only accounts the page still has
        }
        return out;
    }

    /** The chat's token (the account's, see credKey in session.ts), renewed when it ran out and the page is not alive. */
    private String tokenFor(JSONObject s, JSONObject auth, boolean alive) throws IOException, JSONException {
        JSONObject device = s.getJSONObject("device");
        String key = s.optString("account", "");
        if (key.isEmpty()) key = device.optString("login", "");
        if (key.isEmpty()) key = "repo:" + s.getString("repo");
        key = key.toLowerCase();
        JSONObject c = auth.optJSONObject(key);
        if (c == null) return s.optString("token", null);
        long now = System.currentTimeMillis(), expires = c.optLong("expiresAt", 0);
        if (expires == 0 || expires - now > 60_000) return c.getString("token");
        String refresh = c.optString("refresh", "");
        long refreshExpires = c.optLong("refreshExpiresAt", 0);
        if (alive || refresh.isEmpty() || (refreshExpires != 0 && refreshExpires < now)) return null;
        // the page may have started since: from here on it waits for this renewal (MainActivity sets alive first,
        // well before the page asks for a token)
        if (MainActivity.alive) return null;
        write("oc-renewing.json", new JSONObject().put("account", key).put("until", now + 70_000).toString());
        try {
            JSONObject d = post(oauth + "/login/oauth/access_token",
                "client_id=" + CLIENT_ID + "&grant_type=refresh_token&refresh_token=" + URLEncoder.encode(refresh, "UTF-8"));
            if (d == null || !d.has("access_token")) return null; // refused or unreachable: the page signs in again when it must
            long at = System.currentTimeMillis(); // after the answer: newer than any copy the page had
            JSONObject next = new JSONObject().put("token", d.getString("access_token")).put("at", at);
            if (d.has("refresh_token")) next.put("refresh", d.getString("refresh_token"));
            if (d.has("expires_in")) next.put("expiresAt", at + d.getLong("expires_in") * 1000);
            if (d.has("refresh_token_expires_in")) next.put("refreshExpiresAt", at + d.getLong("refresh_token_expires_in") * 1000);
            // signed out meanwhile: keep nothing
            JSONObject page = json(read("oc-auth.json"));
            if (read("oc-session.json") == null || page == null || !page.has(key)) return null;
            JSONObject bg = json(read("oc-auth-bg.json"));
            write("oc-auth-bg.json", (bg == null ? new JSONObject() : bg).put(key, next).toString());
            auth.put(key, next); // another chat of this account uses it in this run
            return next.getString("token");
        } finally { new File(getFilesDir(), "oc-renewing.json").delete(); }
    }

    // ---------- GitHub ----------

    private String head(String repo, String token) throws IOException, JSONException {
        JSONObject ref = get("/repos/" + repo + "/git/ref/heads/main", token);
        return ref == null ? null : ref.getJSONObject("object").getString("sha");
    }

    private JSONObject blob(String repo, String sha, String token) throws IOException, JSONException {
        JSONObject b = get("/repos/" + repo + "/git/blobs/" + sha, token);
        return b == null ? null : json(new String(Base64.decode(b.getString("content"), Base64.DEFAULT), StandardCharsets.UTF_8));
    }

    private JSONObject blobAt(String repo, String path, String ref, String token) throws IOException, JSONException {
        JSONObject c = get("/repos/" + repo + "/contents/" + path + "?ref=" + ref, token);
        return c == null ? null : json(new String(Base64.decode(c.getString("content"), Base64.DEFAULT), StandardCharsets.UTF_8));
    }

    /** A JSON answer, or null for 404 (and 409, an empty repository); other failures throw. */
    private JSONObject get(String path, String token) throws IOException, JSONException {
        HttpURLConnection c = (HttpURLConnection) new URL(api + path).openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(30_000);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Accept", "application/vnd.github+json");
        c.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
        try {
            int status = c.getResponseCode();
            if (status == 404 || status == 409) return null;
            if (status != 200) throw new IOException("GitHub " + status + " " + path);
            return json(text(c.getInputStream()));
        } finally { c.disconnect(); }
    }

    private JSONObject post(String url, String form) throws IOException, JSONException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(60_000); // a renewal answer lost is a sign-in lost: wait for it
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Accept", "application/json");
        c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
        try {
            try (OutputStream o = c.getOutputStream()) { o.write(form.getBytes(StandardCharsets.UTF_8)); }
            return c.getResponseCode() == 200 ? json(text(c.getInputStream())) : null;
        } finally { c.disconnect(); }
    }

    // ---------- files (Capacitor's Directory.Data is getFilesDir()) ----------

    private String read(String name) {
        try { return text(new FileInputStream(new File(getFilesDir(), name))); } catch (IOException e) { return null; }
    }

    /** Written whole to a new file and renamed over the old one, so a reader never sees half of it. */
    private void write(String name, String text) throws IOException {
        File tmp = new File(getFilesDir(), name + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(text.getBytes(StandardCharsets.UTF_8)); o.getFD().sync(); }
        if (!tmp.renameTo(new File(getFilesDir(), name))) throw new IOException("could not write " + name);
    }

    private static String text(InputStream in) throws IOException {
        try (InputStream i = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = i.read(buf)) > 0; ) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static JSONObject json(String text) {
        if (text == null) return null;
        try { return new JSONObject(text); } catch (JSONException e) { return null; }
    }
}
