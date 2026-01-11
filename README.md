# Voice Chat Web - Frontend

This is the frontend application for the Voice Chat Discord-style interface.

## Files

- `index.html` - Main HTML structure
- `styles.css` - All styling (Discord-like theme)
- `app.js` - WebRTC and SignalR client logic

## Configuration

Update the `SIGNALING_URL` in `app.js` to point to your signaling server:

```javascript
const SIGNALING_URL = 'http://localhost:5000/signaling'; // Local
// or
const SIGNALING_URL = 'wss://your-server.com/signaling'; // Production
```

## Features

- Real-time text messaging
- Voice channels with WebRTC
- User list with online status
- Channel creation
- Username customization
- Mute/Deafen controls
