# Raja Chor Sipahi Mantri

A responsive, private multiplayer web game for four players. The game distributes roles, lets the Sipahi identify the Chor, tracks scores, and supports multiple rounds.

## Features

- Private rooms with six-character invite codes
- Four-player lobby with host and guest roles
- Secure, host-authoritative role shuffling
- Animated secret-chit reveal
- Sipahi suspect selection and score calculation
- Round results and next-round support
- Responsive light and dark interface

## Run locally

Because the app uses browser modules and PeerJS networking, serve the project over HTTP rather than opening `index.html` directly.

```bash
# From the project directory
python -m http.server 8000
```

Then open `http://localhost:8000` in a browser.

## Play

1. Enter a player name.
2. Create a private room or join using a room code.
3. Share the room code or invite link with three friends.
4. The host starts the game once all four players join.
5. Reveal your secret role and mark yourself ready.
6. The Sipahi chooses a suspect; the round result and scores are then shown.

## Project structure

- `index.html` - page structure and game screens
- `style.css` - layout, themes, animations, and responsive styles
- `app.js` - room networking, role distribution, game logic, and UI behavior

## Technologies

- HTML5
- CSS3
- Vanilla JavaScript
- PeerJS/WebRTC
- Google Fonts
