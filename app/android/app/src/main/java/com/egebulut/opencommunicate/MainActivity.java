package com.egebulut.opencommunicate;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** The app's page exists (open, or in the background): it notifies for its open chat itself, see MessageCheck. */
    static volatile boolean alive;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        alive = true;
        MessageCheck.schedule(this);
    }

    @Override
    public void onDestroy() {
        alive = false;
        super.onDestroy();
    }
}
