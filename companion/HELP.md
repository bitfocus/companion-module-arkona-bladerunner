## Arkona Technologies BLADE//runner

Monitor and control Arkona Technologies BLADE//runner frames.

### Supported Models

- BLADE//runner AT1130

### Getting started

1. Add a connection and choose **Arkona Technologies: BLADE//runner**.
2. Set **Blade IP** to the frame's management address.
3. Leave **Port** at `80` and **Protocol** at `ws (http)` unless the Blade is served over HTTPS — then use `wss` and the HTTPS port.
4. Set a **Reservation Marker**. The Blade only accepts control commands from a session that holds one. The default is `Bitfocus-Connection`. If another session (the Blade web UI or another connection) already holds a marker, use that same value to work alongside it, or clear it on the device.
5. Fill in **Username** and **Password** only if the Blade is password-protected.

Monitoring variables work without a reservation marker. Routing, BNC direction, identify, reboot, and time-source changes require one. If an action is blocked, match this connection's Reservation Marker to the value shown on the Blade.
