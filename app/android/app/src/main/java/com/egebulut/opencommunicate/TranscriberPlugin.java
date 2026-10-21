package com.egebulut.opencommunicate;

import android.content.Intent;
import android.media.AudioFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * What a voice message says: Android's on-device recognizer fed the recording (16-bit mono PCM, base64) instead of
 * the microphone, which the app holds while it records (RecognizerIntent.EXTRA_AUDIO_SOURCE, Android 13+). A
 * segmented session reads the whole recording, pauses included, and ends when the audio does. Nothing leaves the
 * phone. Without on-device recognition the text is empty and the voice message goes without it.
 */
@CapacitorPlugin(name = "Transcriber")
public class TranscriberPlugin extends Plugin {

    @PluginMethod
    public void transcribe(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || !SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext())) {
            call.resolve(new JSObject().put("text", ""));
            return;
        }
        byte[] pcm = Base64.decode(call.getString("pcm", ""), Base64.DEFAULT);
        int rate = call.getInt("rate", 16000);
        String language = call.getString("language", "en-US");
        new Handler(Looper.getMainLooper()).post(() -> run(call, pcm, rate, language));
    }

    private void run(PluginCall call, byte[] pcm, int rate, String language) {
        ParcelFileDescriptor[] pipe;
        try {
            pipe = ParcelFileDescriptor.createPipe();
        } catch (IOException e) {
            call.reject("Could not pass the recording on: " + e.getMessage());
            return;
        }
        SpeechRecognizer recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(getContext());
        StringBuilder text = new StringBuilder();
        AtomicBoolean done = new AtomicBoolean(false);
        Handler main = new Handler(Looper.getMainLooper());
        Runnable finish = () -> {
            if (done.getAndSet(true)) return;
            recognizer.destroy();
            try { pipe[0].close(); } catch (IOException ignored) { /* closed */ }
            call.resolve(new JSObject().put("text", text.toString().trim()));
        };
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        recognizer.setRecognitionListener(new RecognitionListener() {
            private void add(Bundle b) {
                ArrayList<String> m = b == null ? null : b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                if (m != null && !m.isEmpty() && !m.get(0).trim().isEmpty()) text.append(text.length() > 0 ? " " : "").append(m.get(0).trim());
            }
            @Override public void onSegmentResults(Bundle b) { add(b); }
            @Override public void onEndOfSegmentedSession() { finish.run(); }
            @Override public void onResults(Bundle b) { add(b); finish.run(); }
            @Override public void onError(int error) {
                // silence or nothing understood ends it with what was heard; another error does too, once text came
                if (text.length() > 0 || error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) { finish.run(); return; }
                if (done.getAndSet(true)) return;
                // the language's model is not on the phone yet: Android offers to download it
                boolean missing = error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE;
                if (missing) recognizer.triggerModelDownload(intent);
                recognizer.destroy();
                try { pipe[0].close(); } catch (IOException ignored) { /* closed */ }
                call.reject(missing ? "the language is downloading; try again once it is in" : "speech recognition failed (" + error + ")");
            }
            @Override public void onReadyForSpeech(Bundle b) {}
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float v) {}
            @Override public void onBufferReceived(byte[] b) {}
            @Override public void onEndOfSpeech() {}
            @Override public void onPartialResults(Bundle b) {}
            @Override public void onEvent(int t, Bundle b) {}
        });
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0]);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, rate);
        intent.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE);
        recognizer.startListening(intent);
        // the recording, then its end, which ends the session
        new Thread(() -> {
            try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
                out.write(pcm);
                out.write(new byte[2 * rate]); // a second of silence: the recognizer keeps the last word
            } catch (IOException ignored) { /* the recognizer stopped reading */ }
        }).start();
        // a recognizer that never answers: what it heard so far, after the recording's length and half a minute
        main.postDelayed(finish, pcm.length * 1000L / (2L * rate) + 30_000);
    }
}
