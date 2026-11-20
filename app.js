(() => {
  'use strict';

  // =========================================================
  // CONSTANTS & ROLE METADATA
  // =========================================================
  const PEER_PREFIX = 'rcsm-private-';
  const MAX_PLAYERS = 4;
  const ROLES = ['Raja', 'Chor', 'Sipahi', 'Mantri'];

  const ROLE_INFO = {
    Raja: {
      icon: '👑',
      cssClass: 'role-raja',
      desc: 'You are the King! Automatic 1000 Points.'
    },
    Chor: {
      icon: '🦹',
      cssClass: 'role-chor',
      desc: 'Stay hidden! Escape Sipahi to steal 500 Points.'
    },
    Sipahi: {
      icon: '🛡️',
      cssClass: 'role-sipahi',
      desc: 'Catch the Chor to win 500 Points!'
    },
    Mantri: {
      icon: '💼',
      cssClass: 'role-mantri',
      desc: 'Royal Advisor! 800 Points if not mistaken for Chor.'
    }
  };

  // Free public STUN servers for reliable WebRTC NAT traversal
  const PEER_CONFIG = {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
      ]
    }
  };

  // =========================================================
  // APPLICATION STATE
  // =========================================================
  const state = {
    peer: null,
    isHost: false,
    roomCode: '',
    myId: '',
    myName: '',
    myRole: null,          // Strictly private per player until round ends
    isCardFlipped: false,
    isReady: false,
    round: 1,
    phase: 'HOME',         // HOME | LOBBY | CHIT | GAME | RESULT
    players: [],           // [{ id, name, isHost, score }]
    selectedSuspectId: null,
    suspects: [],          // [{ id, name }] (Only the 2 non-Raja/non-Sipahi players)
    rajaPlayer: null,
    sipahiPlayer: null,

    // Host-only authoritative secrets (never sent to guests until round ends)
    hostConnections: new Map(), // peerId -> DataConnection
    hostSecretRoles: new Map(), // peerId -> 'Raja'|'Chor'|'Sipahi'|'Mantri'
    hostReadySet: new Set(),
    guestHostConn: null
  };

  // =========================================================
  // DOM REFERENCES
  // =========================================================
  const $ = (id) => document.getElementById(id);

  const screens = {
    HOME: $('screen-home'),
    LOBBY: $('screen-lobby'),
    CHIT: $('screen-chit'),
    GAME: $('screen-game'),
    RESULT: $('screen-result')
  };

  // =========================================================
  // INITIALIZATION & URL INVITE PARSING
  // =========================================================
  function init() {
    const params = new URLSearchParams(window.location.search);
    const inviteCode = params.get('code');
    if (inviteCode) {
      $('room-code-input').value = inviteCode.trim().toUpperCase().slice(0, 6);
    }

    const savedName = localStorage.getItem('rcsm_player_name');
    if (savedName) {
      $('player-name-input').value = savedName;
    }

    bindEvents();
  }

  function bindEvents() {
    $('toast-close').addEventListener('click', hideToast);
    $('modal-home-btn').addEventListener('click', resetToHome);

    // Screen 1: Home
    $('create-room-btn').addEventListener('click', handleCreateRoom);
    $('join-room-btn').addEventListener('click', handleJoinRoom);
    $('room-code-input').addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    });

    // Screen 2: Lobby
    $('leave-lobby-btn').addEventListener('click', resetToHome);
    $('copy-code-btn').addEventListener('click', copyRoomCode);
    $('share-link-btn').addEventListener('click', shareInviteLink);
    $('start-game-btn').addEventListener('click', () => {
      if (state.isHost && state.players.length === MAX_PLAYERS) {
        hostStartNewRound();
      }
    });

    // Screen 3: Chit Reveal
    $('chit-card-trigger').addEventListener('click', toggleCardFlip);
    $('toggle-flip-btn').addEventListener('click', toggleCardFlip);
    $('im-ready-btn').addEventListener('click', handlePlayerReady);

    // Screen 4: Public Arena & Sipahi Guess
    $('suspect-card-0').addEventListener('click', () => handleSuspectTap(0));
    $('suspect-card-1').addEventListener('click', () => handleSuspectTap(1));
    $('confirm-guess-btn').addEventListener('click', handleConfirmGuess);

    // Screen 6: Next Round
    $('next-round-btn').addEventListener('click', () => {
      if (state.isHost) {
        state.round += 1;
        hostStartNewRound();
      }
    });
  }

  // =========================================================
  // VIEW & THEME MANAGER
  // =========================================================
  function switchScreen(screenKey) {
    state.phase = screenKey;
    Object.entries(screens).forEach(([key, el]) => {
      el.classList.toggle('active', key === screenKey);
    });

    const isDark = ['CHIT', 'GAME', 'RESULT'].includes(screenKey);
    document.body.classList.toggle('theme-dark', isDark);
    document.body.classList.toggle('theme-light', !isDark);
  }

  let toastTimer = null;
  function showToast(msg, icon = '⚠️') {
    $('toast-icon').textContent = icon;
    $('toast-message').textContent = msg;
    $('toast-banner').classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 4200);
  }

  function hideToast() {
    $('toast-banner').classList.add('hidden');
  }

  function showDisconnectModal(title, desc) {
    $('modal-title').textContent = title;
    $('modal-desc').textContent = desc;
    $('disconnect-modal').classList.remove('hidden');
  }

  function resetToHome() {
    if (state.peer) {
      try { state.peer.destroy(); } catch (_) {}
    }
    state.peer = null;
    state.isHost = false;
    state.roomCode = '';
    state.myRole = null;
    state.players = [];
    state.hostConnections.clear();
    state.hostSecretRoles.clear();
    state.hostReadySet.clear();
    state.guestHostConn = null;
    state.round = 1;

    $('disconnect-modal').classList.add('hidden');
    $('create-room-btn').disabled = false;
    $('join-room-btn').disabled = false;
    switchScreen('HOME');
  }

  // =========================================================
  // CRYPTOGRAPHIC HELPERS (ANTI-CHEAT SHUFFLE & ROOM CODE)
  // =========================================================
  function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excludes ambiguous 0/O, 1/I
    const array = new Uint32Array(6);
    crypto.getRandomValues(array);
    return Array.from(array, (x) => chars[x % chars.length]).join('');
  }

  function cryptoShuffle(list) {
    const arr = [...list];
    const rand = new Uint32Array(arr.length);
    crypto.getRandomValues(rand);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = rand[i] % (i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function validateName() {
    const raw = $('player-name-input').value.trim();
    if (!raw) {
      showToast('Please enter your name first!', '✍️');
      $('player-name-input').focus();
      return null;
    }
    localStorage.setItem('rcsm_player_name', raw);
    return raw;
  }

  // =========================================================
  // PEERJS NETWORKING: HOST FLOW (STAR TOPOLOGY AUTHORITY)
  // =========================================================
  function handleCreateRoom() {
    const name = validateName();
    if (!name) return;

    $('create-room-btn').disabled = true;
    const code = generateRoomCode();
    const peerId = PEER_PREFIX + code;

    const peer = new Peer(peerId, PEER_CONFIG);
    state.peer = peer;
    state.isHost = true;
    state.roomCode = code;
    state.myName = name;

    peer.on('open', (id) => {
      state.myId = id;
      state.players = [{ id, name, isHost: true, score: 0 }];
      renderLobby();
      switchScreen('LOBBY');
      showToast(`Private room ${code} created!`, '👑');
    });

    peer.on('connection', (conn) => {
      handleIncomingGuestConnection(conn);
    });

    peer.on('error', (err) => {
      $('create-room-btn').disabled = false;
      if (err.type === 'unavailable-id') {
        handleCreateRoom(); // Retry with fresh code if collision
      } else {
        showToast(`Network error: ${err.type}. Check your connection.`, '🔌');
      }
    });
  }

  function handleIncomingGuestConnection(conn) {
    conn.on('open', () => {
      // Strict 4-Player Cap & Mid-Game Lock
      if (state.players.length >= MAX_PLAYERS || state.phase !== 'LOBBY') {
        conn.send({
          type: 'ERROR',
          message: 'Room is full (4/4) or the game has already started.'
        });
        setTimeout(() => conn.close(), 250);
        return;
      }
    });

    conn.on('data', (data) => {
      if (!data || typeof data !== 'object') return;

      switch (data.type) {
        case 'JOIN_REQUEST': {
          if (state.players.length >= MAX_PLAYERS || state.phase !== 'LOBBY') {
            conn.send({
              type: 'ERROR',
              message: 'Room is full or already started.'
            });
            setTimeout(() => conn.close(), 250);
            return;
          }

          const cleanName = String(data.name || 'Friend').trim().slice(0, 16) || 'Friend';
          state.hostConnections.set(conn.peer, conn);
          state.players.push({
            id: conn.peer,
            name: cleanName,
            isHost: false,
            score: 0
          });

          broadcastLobbyState();
          renderLobby();
          break;
        }

        case 'PLAYER_READY': {
          if (state.phase !== 'CHIT') return;
          state.hostReadySet.add(conn.peer);
          broadcastReadyCount();
          checkAllPlayersReady();
          break;
        }

        case 'SELECT_SUSPECT': {
          // Verify sender is actually Sipahi
          if (state.phase !== 'GAME') return;
          if (state.hostSecretRoles.get(conn.peer) !== 'Sipahi') return;
          if (!state.suspects.some((s) => s.id === data.targetId)) return;

          state.selectedSuspectId = data.targetId;
          broadcast({ type: 'SUSPECT_HIGHLIGHTED', targetId: data.targetId });
          applySuspectHighlight(data.targetId);
          break;
        }

        case 'CONFIRM_GUESS': {
          // Verify sender is actually Sipahi
          if (state.phase !== 'GAME') return;
          if (state.hostSecretRoles.get(conn.peer) !== 'Sipahi') return;
          if (!state.suspects.some((s) => s.id === data.targetId)) return;

          hostResolveRound(data.targetId);
          break;
        }
      }
    });

    conn.on('close', () => {
      handlePeerDisconnected(conn.peer);
    });

    conn.on('error', () => {
      handlePeerDisconnected(conn.peer);
    });
  }

  function handlePeerDisconnected(peerId) {
    if (!state.isHost) return;
    const leavingPlayer = state.players.find((p) => p.id === peerId);
    if (!leavingPlayer) return;

    state.hostConnections.delete(peerId);
    state.players = state.players.filter((p) => p.id !== peerId);

    if (state.phase === 'LOBBY') {
      broadcastLobbyState();
      renderLobby();
      showToast(`${leavingPlayer.name} left the lobby.`, '👋');
    } else {
      // Mid-game disconnect warning
      broadcast({
        type: 'PLAYER_DISCONNECTED',
        name: leavingPlayer.name
      });
      showDisconnectModal(
        'Player Disconnected',
        `${leavingPlayer.name} lost connection mid-game. Return to Home to start a fresh room.`
      );
    }
  }

  function broadcast(payload) {
    state.hostConnections.forEach((conn) => {
      if (conn.open) {
        conn.send(payload);
      }
    });
  }

  function broadcastLobbyState() {
    broadcast({
      type: 'LOBBY_UPDATE',
      roomCode: state.roomCode,
      players: state.players
    });
  }

  // =========================================================
  // PEERJS NETWORKING: GUEST FLOW
  // =========================================================
  function handleJoinRoom() {
    const name = validateName();
    if (!name) return;

    const code = $('room-code-input').value.trim().toUpperCase();
    if (code.length !== 6) {
      showToast('Enter a valid 6-character Room Code!', '🔑');
      $('room-code-input').focus();
      return;
    }

    $('join-room-btn').disabled = true;
    showToast('Connecting to Host...', '📡');

    const peer = new Peer(PEER_CONFIG);
    state.peer = peer;
    state.isHost = false;
    state.roomCode = code;
    state.myName = name;

    let connectionTimeout = null;

    peer.on('open', (myId) => {
      state.myId = myId;
      const hostPeerId = PEER_PREFIX + code;
      const conn = peer.connect(hostPeerId, { reliable: true });
      state.guestHostConn = conn;

      connectionTimeout = setTimeout(() => {
        if (state.phase === 'HOME') {
          $('join-room-btn').disabled = false;
          showToast('Room not found or Host is offline.', '❌');
          try { peer.destroy(); } catch (_) {}
        }
      }, 8000);

      conn.on('open', () => {
        clearTimeout(connectionTimeout);
        conn.send({ type: 'JOIN_REQUEST', name });
      });

      conn.on('data', (data) => {
        clearTimeout(connectionTimeout);
        handleMessageFromHost(data);
      });

      conn.on('close', () => {
        clearTimeout(connectionTimeout);
        if (state.phase !== 'HOME') {
          showDisconnectModal(
            'Host Disconnected',
            'The Host closed the room or lost internet connection.'
          );
        }
      });

      conn.on('error', () => {
        clearTimeout(connectionTimeout);
        $('join-room-btn').disabled = false;
        showToast('Could not connect to room.', '❌');
      });
    });

    peer.on('error', (err) => {
      clearTimeout(connectionTimeout);
      $('join-room-btn').disabled = false;
      if (err.type === 'peer-unavailable') {
        showToast(`Room "${code}" does not exist. Check the code!`, '🔍');
      } else {
        showToast(`Connection error: ${err.type}`, '🔌');
      }
    });
  }

  function handleMessageFromHost(data) {
    if (!data || typeof data !== 'object') return;

    switch (data.type) {
      case 'ERROR': {
        $('join-room-btn').disabled = false;
        showToast(data.message || 'Unable to join room.', '🚫');
        try { state.peer.destroy(); } catch (_) {}
        break;
      }

      case 'LOBBY_UPDATE': {
        state.roomCode = data.roomCode;
        state.players = data.players;
        renderLobby();
        if (state.phase !== 'LOBBY') {
          switchScreen('LOBBY');
        }
        break;
      }

      case 'YOUR_ROLE': {
        // Guest ONLY receives their own secret role
        state.round = data.round;
        state.myRole = data.role;
        enterChitScreen();
        break;
      }

      case 'READY_COUNT': {
        $('ready-counter-badge').textContent = `${data.readyCount}/4 Ready`;
        break;
      }

      case 'START_GAMEPLAY': {
        // Host sends ONLY Raja, Sipahi, and the 2 anonymous suspects
        state.rajaPlayer = data.raja;
        state.sipahiPlayer = data.sipahi;
        state.suspects = data.suspects;
        state.selectedSuspectId = null;
        enterGameplayScreen();
        break;
      }

      case 'SUSPECT_HIGHLIGHTED': {
        state.selectedSuspectId = data.targetId;
        applySuspectHighlight(data.targetId);
        break;
      }

      case 'ROUND_RESULT': {
        state.players = data.players;
        renderResultScreen(data);
        break;
      }

      case 'PLAYER_DISCONNECTED': {
        showDisconnectModal(
          'Player Disconnected',
          `${data.name} disconnected from the match.`
        );
        break;
      }
    }
  }

  // =========================================================
  // SCREEN 2: LOBBY RENDERING & INVITE SHARING
  // =========================================================
  function renderLobby() {
    $('display-room-code').textContent = state.roomCode;
    const count = state.players.length;
    $('player-count-badge').textContent = `${count} / 4`;

    const statusPill = $('lobby-status-pill');
    if (count === MAX_PLAYERS) {
      statusPill.textContent = '● Ready!';
      statusPill.className = 'status-pill ready';
    } else {
      statusPill.textContent = '● Waiting';
      statusPill.className = 'status-pill waiting';
    }

    const listEl = $('player-slots-list');
    listEl.innerHTML = '';

    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = state.players[i];
      const row = document.createElement('div');
      if (p) {
        row.className = 'slot-row';
        row.innerHTML = `
          <div class="slot-left">
            <span class="slot-avatar">👤</span>
            <span>${escapeHtml(p.name)}</span>
            ${p.isHost ? '<span class="host-tag">👑 Host</span>' : ''}
            ${p.id === state.myId ? '<span class="host-tag" style="background:#059669;">You</span>' : ''}
          </div>
          <span class="joined-tag">✔ Joined</span>
        `;
      } else {
        row.className = 'slot-row empty';
        row.innerHTML = `
          <div class="slot-left">
            <span class="slot-avatar">👤</span>
            <span>Waiting for friend...</span>
          </div>
          <span class="waiting-tag">Waiting</span>
        `;
      }
      listEl.appendChild(row);
    }

    if (state.isHost) {
      $('start-game-btn').classList.remove('hidden');
      $('guest-wait-msg').classList.add('hidden');
      $('start-game-btn').disabled = count !== MAX_PLAYERS;
      $('start-game-btn').textContent =
        count === MAX_PLAYERS ? '▶ Start Game (4/4)' : `▶ Start Game (${count}/4)`;
    } else {
      $('start-game-btn').classList.add('hidden');
      $('guest-wait-msg').classList.remove('hidden');
    }
  }

  function buildInviteUrl() {
    const url = new URL(window.location.href);
    url.search = `?code=${state.roomCode}`;
    return url.toString();
  }

  function copyRoomCode() {
    navigator.clipboard?.writeText(state.roomCode);
    showToast(`Room code ${state.roomCode} copied!`, '📋');
  }

  async function shareInviteLink() {
    const inviteUrl = buildInviteUrl();
    const shareData = {
      title: 'Join Raja Chor Sipahi Mantri!',
      text: `Join my private Raja Chor Sipahi Mantri room! Code: ${state.roomCode}`,
      url: inviteUrl
    };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch (_) {}
    }

    navigator.clipboard?.writeText(inviteUrl);
    showToast('Invite link copied! Paste in WhatsApp or chat.', '🔗');
  }

  // =========================================================
  // SCREEN 3: HOST ROLE DISTRIBUTION & CHIT REVEAL
  // =========================================================
  function hostStartNewRound() {
    state.hostSecretRoles.clear();
    state.hostReadySet.clear();
    state.selectedSuspectId = null;

    const shuffledRoles = cryptoShuffle(ROLES);

    // Assign roles strictly on Host and send ONLY each peer's own secret role
    state.players.forEach((player, idx) => {
      const assignedRole = shuffledRoles[idx];
      state.hostSecretRoles.set(player.id, assignedRole);

      if (player.id === state.myId) {
        state.myRole = assignedRole;
      } else {
        const conn = state.hostConnections.get(player.id);
        if (conn && conn.open) {
          conn.send({
            type: 'YOUR_ROLE',
            round: state.round,
            role: assignedRole
          });
        }
      }
    });

    enterChitScreen();
  }

  function enterChitScreen() {
    state.isCardFlipped = false;
    state.isReady = false;

    $('chit-round-badge').textContent = `Round ${state.round}`;
    $('ready-counter-badge').textContent = '0/4 Ready';
    $('secret-flip-card').classList.remove('is-flipped');
    $('toggle-flip-btn').textContent = '👁️ Tap to Reveal';
    $('chit-instruction').textContent = 'Tap the chit to peek at your role';
    $('im-ready-btn').disabled = true;
    $('im-ready-btn').textContent = "✅ I'm Ready";
    $('ready-status-text').textContent = 'Reveal your chit first to continue';

    // Configure secret back face
    const info = ROLE_INFO[state.myRole];
    const backEl = $('secret-card-back');
    backEl.className = `flip-face flip-back ${info.cssClass}`;
    $('secret-role-icon').textContent = info.icon;
    $('secret-role-name').textContent = state.myRole.toUpperCase();
    $('secret-role-desc').textContent = info.desc;

    // Show shuffle animation first, then reveal chit card
    $('chit-shuffle-view').classList.remove('hidden');
    $('chit-reveal-view').classList.add('hidden');
    switchScreen('CHIT');

    setTimeout(() => {
      if (state.phase === 'CHIT') {
        $('chit-shuffle-view').classList.add('hidden');
        $('chit-reveal-view').classList.remove('hidden');
      }
    }, 1800);
  }

  function toggleCardFlip() {
    state.isCardFlipped = !state.isCardFlipped;
    $('secret-flip-card').classList.toggle('is-flipped', state.isCardFlipped);

    if (state.isCardFlipped) {
      $('toggle-flip-btn').textContent = '🙈 Tap to Hide';
      $('chit-instruction').textContent = 'Tap again to hide from neighbors';
      if (!state.isReady) {
        $('im-ready-btn').disabled = false;
        $('ready-status-text').textContent = 'Tap "I\'m Ready" once you\'ve seen your role';
      }
    } else {
      $('toggle-flip-btn').textContent = '👁️ Tap to Reveal';
      $('chit-instruction').textContent = 'Chit hidden! Tap to peek again';
    }
  }

  function handlePlayerReady() {
    if (state.isReady) return;
    state.isReady = true;

    // Auto-hide chit for privacy when locking in ready
    if (state.isCardFlipped) {
      toggleCardFlip();
    }

    $('im-ready-btn').disabled = true;
    $('im-ready-btn').textContent = '⏳ Waiting for others...';
    $('ready-status-text').textContent = 'Role confirmed! Waiting for all 4 friends...';

    if (state.isHost) {
      state.hostReadySet.add(state.myId);
      broadcastReadyCount();
      checkAllPlayersReady();
    } else if (state.guestHostConn && state.guestHostConn.open) {
      state.guestHostConn.send({ type: 'PLAYER_READY' });
    }
  }

  function broadcastReadyCount() {
    const readyCount = state.hostReadySet.size;
    $('ready-counter-badge').textContent = `${readyCount}/4 Ready`;
    broadcast({ type: 'READY_COUNT', readyCount });
  }

  function checkAllPlayersReady() {
    if (!state.isHost) return;
    if (state.hostReadySet.size < MAX_PLAYERS) return;

    // Identify Raja, Sipahi, and the 2 suspects (Chor + Mantri without revealing which is which)
    let raja = null;
    let sipahi = null;
    const suspectList = [];

    state.players.forEach((p) => {
      const role = state.hostSecretRoles.get(p.id);
      if (role === 'Raja') raja = { id: p.id, name: p.name };
      else if (role === 'Sipahi') sipahi = { id: p.id, name: p.name };
      else suspectList.push({ id: p.id, name: p.name });
    });

    // Randomize left/right card order so position doesn't leak role
    const randomizedSuspects = cryptoShuffle(suspectList);

    state.rajaPlayer = raja;
    state.sipahiPlayer = sipahi;
    state.suspects = randomizedSuspects;
    state.selectedSuspectId = null;

    broadcast({
      type: 'START_GAMEPLAY',
      raja,
      sipahi,
      suspects: randomizedSuspects
    });

    enterGameplayScreen();
  }

  // =========================================================
  // SCREEN 4: PUBLIC ARENA & SIPAHI'S GUESS
  // =========================================================
  function enterGameplayScreen() {
    $('game-round-badge').textContent = `Round ${state.round}`;
    $('arena-raja-name').textContent = state.rajaPlayer.name;
    $('arena-sipahi-name').textContent = state.sipahiPlayer.name;

    const amISipahi = state.myRole === 'Sipahi';

    // Populate the 2 anonymous suspect cards
    state.suspects.forEach((suspect, idx) => {
      const card = $(`suspect-card-${idx}`);
      const nameEl = $(`suspect-name-${idx}`);
      card.dataset.playerId = suspect.id;
      card.classList.remove('selected');
      card.disabled = !amISipahi;
      nameEl.textContent = suspect.name;
    });

    if (amISipahi) {
      $('sipahi-prompt-banner').textContent = '🎯 You are Sipahi! Choose the Chor!';
      $('confirm-guess-btn').classList.remove('hidden');
      $('confirm-guess-btn').disabled = true;
      $('spectator-hint').classList.add('hidden');
    } else {
      $('sipahi-prompt-banner').textContent = `🎯 ${state.sipahiPlayer.name} (Sipahi) is hunting...`;
      $('confirm-guess-btn').classList.add('hidden');
      $('spectator-hint').classList.remove('hidden');
      $('waiting-sipahi-name').textContent = state.sipahiPlayer.name;
    }

    switchScreen('GAME');
  }

  function handleSuspectTap(index) {
    if (state.myRole !== 'Sipahi') return;
    const suspect = state.suspects[index];
    if (!suspect) return;

    state.selectedSuspectId = suspect.id;
    applySuspectHighlight(suspect.id);
    $('confirm-guess-btn').disabled = false;

    if (state.isHost) {
      broadcast({ type: 'SUSPECT_HIGHLIGHTED', targetId: suspect.id });
    } else if (state.guestHostConn && state.guestHostConn.open) {
      state.guestHostConn.send({ type: 'SELECT_SUSPECT', targetId: suspect.id });
    }
  }

  function applySuspectHighlight(targetId) {
    [0, 1].forEach((idx) => {
      const card = $(`suspect-card-${idx}`);
      card.classList.toggle('selected', card.dataset.playerId === targetId);
    });
  }

  function handleConfirmGuess() {
    if (state.myRole !== 'Sipahi' || !state.selectedSuspectId) return;
    $('confirm-guess-btn').disabled = true;

    if (state.isHost) {
      hostResolveRound(state.selectedSuspectId);
    } else if (state.guestHostConn && state.guestHostConn.open) {
      state.guestHostConn.send({
        type: 'CONFIRM_GUESS',
        targetId: state.selectedSuspectId
      });
    }
  }

  // =========================================================
  // SCREEN 5 & 6: HOST SCORING & RESULT ANIMATIONS
  // =========================================================
  function hostResolveRound(guessedPlayerId) {
    const actualRoleOfGuessed = state.hostSecretRoles.get(guessedPlayerId);
    const isCorrect = actualRoleOfGuessed === 'Chor';

    const roundBreakdown = state.players.map((p) => {
      const role = state.hostSecretRoles.get(p.id);
      let delta = 0;

      if (role === 'Raja') delta = 1000;
      else if (role === 'Mantri') delta = 800;
      else if (role === 'Sipahi') delta = isCorrect ? 500 : 0;
      else if (role === 'Chor') delta = isCorrect ? 0 : 500;

      p.score += delta;

      return {
        id: p.id,
        name: p.name,
        role,
        delta,
        totalScore: p.score
      };
    });

    const resultPayload = {
      type: 'ROUND_RESULT',
      round: state.round,
      isCorrect,
      players: state.players,
      breakdown: roundBreakdown
    };

    broadcast(resultPayload);
    renderResultScreen(resultPayload);
  }

  function renderResultScreen(data) {
    const { round, isCorrect, breakdown } = data;
    $('result-round-badge').textContent = `Round ${round} Result`;

    const ribbon = $('outcome-banner');
    const jailBars = $('jail-bars');

    // Re-trigger CSS drop animation cleanly
    jailBars.style.animation = 'none';
    void jailBars.offsetWidth;
    jailBars.style.animation = '';

    const chorEntry = breakdown.find((b) => b.role === 'Chor');
    const sipahiEntry = breakdown.find((b) => b.role === 'Sipahi');

    if (isCorrect) {
      // Outcome A: Sipahi Catches Chor
      ribbon.className = 'outcome-ribbon ribbon-correct';
      $('outcome-icon').textContent = '✔';
      $('outcome-title').textContent = 'CORRECT!';
      $('outcome-subtitle').textContent = 'Sipahi ne sahi Chor pakda!';

      $('reaction-emoji').textContent = '🛡️🥳';
      $('reaction-caption').textContent = `${sipahiEntry.name} Wins +500!`;

      $('jailed-avatar').textContent = '🦹';
      $('jailed-player-name').textContent = chorEntry.name;
      $('jailed-role-label').textContent = 'Chor (Caught!)';
      $('jail-plate-text').textContent = 'Chor Jail Mein!';
    } else {
      // Outcome B: Sipahi Chooses Mantri (Wrong)
      ribbon.className = 'outcome-ribbon ribbon-wrong';
      $('outcome-icon').textContent = '✖';
      $('outcome-title').textContent = 'WRONG!';
      $('outcome-subtitle').textContent = 'Sipahi ne galat player ko Chor samjha!';

      $('reaction-emoji').textContent = '👑😠';
      $('reaction-caption').textContent = `Chor Escaped! (+500)`;

      $('jailed-avatar').textContent = '🛡️';
      $('jailed-player-name').textContent = sipahiEntry.name;
      $('jailed-role-label').textContent = 'Sipahi (Punished!)';
      $('jail-plate-text').textContent = 'Sipahi Jail Mein!';
    }

    // Sort scoreboard by cumulative Total Score descending
    const sorted = [...breakdown].sort((a, b) => b.totalScore - a.totalScore);
    const highestScore = sorted[0]?.totalScore ?? 0;

    const listEl = $('scoreboard-list');
    listEl.innerHTML = '';

    sorted.forEach((entry) => {
      const isLeader = entry.totalScore === highestScore && highestScore > 0;
      const roleMeta = ROLE_INFO[entry.role];

      const row = document.createElement('div');
      row.className = `score-row ${isLeader ? 'leader' : ''}`;
      row.innerHTML = `
        <div class="score-left">
          <span class="score-role-icon">${roleMeta.icon}</span>
          <div class="score-player-meta">
            <span class="score-player-name">
              ${isLeader ? '👑 ' : ''}${escapeHtml(entry.name)}
            </span>
            <span class="score-role-label">${entry.role}</span>
          </div>
        </div>
        <div class="score-right">
          <span class="round-delta ${entry.delta === 0 ? 'zero' : ''}">
            +${entry.delta}
          </span>
          <span class="total-pts">${entry.totalScore}</span>
        </div>
      `;
      listEl.appendChild(row);
    });

    if (state.isHost) {
      $('next-round-btn').classList.remove('hidden');
      $('guest-next-round-msg').classList.add('hidden');
    } else {
      $('next-round-btn').classList.add('hidden');
      $('guest-next-round-msg').classList.remove('hidden');
    }

    switchScreen('RESULT');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Boot app
  init();
})();