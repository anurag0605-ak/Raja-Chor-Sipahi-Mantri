(() => {
  'use strict';

 
  const PEER_PREFIX = 'rcsm-private-';
  const MAX_PLAYERS = 4;
  const DEFAULT_SOUND_VOLUME = 0.3;
  const SESSION_STORAGE_KEY = 'rcsm_active_session_v1';
  const PLAYER_RECONNECT_GRACE_MS = 40000;
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
  // hostSecretRoles

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
    isGuessConfirmed: false,
    round: 1,
    phase: 'HOME',         // HOME | LOBBY | CHIT | GAME | RESULT
    sessionId: '',
    lastResult: null,
    players: [],           // [{ id, name, isHost, isBot, score }]
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

  let audioContext = null;
  let masterGain = null;
  let soundEnabled = true;
  let soundVolume = DEFAULT_SOUND_VOLUME;
  let rajaRevealAudio = null;
  let hasPlayedRajaRevealSound = false;
  let correctGuessAudio = null;
  let wrongGuessAudio = null;
  let jailAudio = null;
  let guestReconnectAttempt = 0;
  let guestReconnectTimer = null;
  let guestReconnecting = false;
  let sessionAbandoned = false;
  let botTurnTimeout = null;
  const reconnectTimers = new Map();

  function getGameSoundSettings() {
    // Use null for the full clip; set seconds (for example 2.5) to crop the audio.
    return {
      rajaReveal: {
        path: 'asset/Hmm Hmm Raja ji Carryminati meme Raja ji Carryminati template Raja ji Carryminati aayan Template.mp3',
        durationSeconds: 3
      },
      correctGuess: {
        path: 'asset/Saat Crore kbc meme template #shorts #viral #fdyml #memes.mp3',
        durationSeconds: null
      },
      wrongGuess: {
        path: 'asset/Ramayan Gayab Sound Effect #soundeffects #nareshsuperstar.mp3',
        durationSeconds: 2.4
      },
      jail: {
        path: 'asset/Shotgun Fahhhh - Sound Effect #memes #funny #shorts #trending #fx #soundeffects #viral.mp3',
        durationSeconds: null
      }
    };
  }

  const GAME_SOUND_SETTINGS = getGameSoundSettings();
  const audioStopTimers = new WeakMap();

  function encodeAudioPath(path) {
    return path.split('/').map(encodeURIComponent).join('/');
  }

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

  function createSessionId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function readSavedSession() {
    let raw;
    try {
      raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    } catch (error) {
      console.error('Unable to read the saved game session:', error);
      showToast('Could not restore the saved game session.', '⚠️');
      return null;
    }
    if (!raw) return null;

    try {
      const saved = JSON.parse(raw);
      const valid = saved &&
        saved.version === 1 &&
        typeof saved.sessionId === 'string' &&
        /^[A-Z0-9]{6}$/.test(saved.roomCode) &&
        typeof saved.myName === 'string' &&
        typeof saved.isHost === 'boolean' &&
        ['HOME', 'LOBBY', 'CHIT', 'GAME', 'RESULT'].includes(saved.phase) &&
        Array.isArray(saved.players);
      if (valid) return saved;
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    } catch (error) {
      console.error('Unable to parse the saved game session:', error);
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }
  }

  function persistSession() {
    if (!state.sessionId || !state.roomCode || !state.myName) return;

    const saved = {
      version: 1,
      sessionId: state.sessionId,
      roomCode: state.roomCode,
      myName: state.myName,
      isHost: state.isHost,
      myId: state.isHost ? state.myId : '',
      phase: state.phase,
      myRole: state.myRole,
      round: state.round,
      isCardFlipped: state.isCardFlipped,
      isReady: state.isReady,
      isGuessConfirmed: state.isGuessConfirmed,
      players: state.players.map((player) => ({
        id: player.id,
        name: player.name,
        isHost: player.isHost,
        isBot: Boolean(player.isBot),
        score: player.score,
        resumeId: player.resumeId || ''
      })),
      hostSecretRoles: Array.from(state.hostSecretRoles.entries()),
      hostReadySet: Array.from(state.hostReadySet),
      selectedSuspectId: state.selectedSuspectId,
      suspects: state.suspects,
      rajaPlayer: state.rajaPlayer,
      sipahiPlayer: state.sipahiPlayer,
      lastResult: state.lastResult
    };

    try {
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(saved));
    } catch (error) {
      console.error('Unable to save the game session:', error);
      showToast('Could not save your game session in this browser.', '⚠️');
    }
  }

  function restoreSession(saved) {
    state.sessionId = saved.sessionId;
    state.roomCode = saved.roomCode;
    state.myName = saved.myName;
    state.isHost = saved.isHost;
    state.myId = saved.isHost ? saved.myId : '';
    state.phase = saved.phase;
    state.myRole = saved.myRole || null;
    state.round = Number.isInteger(saved.round) ? saved.round : 1;
    state.isCardFlipped = Boolean(saved.isCardFlipped);
    state.isReady = Boolean(saved.isReady);
    state.isGuessConfirmed = Boolean(saved.isGuessConfirmed);
    state.players = saved.players;
    state.hostSecretRoles = new Map(Array.isArray(saved.hostSecretRoles) ? saved.hostSecretRoles : []);
    state.hostReadySet = new Set(Array.isArray(saved.hostReadySet) ? saved.hostReadySet : []);
    state.selectedSuspectId = saved.selectedSuspectId || null;
    state.suspects = Array.isArray(saved.suspects) ? saved.suspects : [];
    state.rajaPlayer = saved.rajaPlayer || null;
    state.sipahiPlayer = saved.sipahiPlayer || null;
    state.lastResult = saved.lastResult || null;
  }

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

    const savedTheme = localStorage.getItem('rcsm_theme');
    if (savedTheme === 'dark' || savedTheme === 'light') {
      applyTheme(savedTheme === 'dark');
    } else {
      applyTheme(false);
    }

    soundEnabled = localStorage.getItem('rcsm_sound_enabled') !== 'false';
    const savedVolume = localStorage.getItem('rcsm_sound_volume');
    if (savedVolume !== null && Number.isFinite(Number(savedVolume))) {
      soundVolume = Math.min(1, Math.max(0, Number(savedVolume)));
    }
    updateSoundControl();

    const savedSession = readSavedSession();
    if (savedSession) {
      restoreSession(savedSession);
      $('player-name-input').value = state.myName;
    }

    bindEvents();
    window.addEventListener('pagehide', persistSession);

    if (savedSession) {
      restoreSessionScreen();
      startSessionResume();
    }
  }

  function bindEvents() {
    document.addEventListener('pointerdown', unlockAudio, { once: true });
    document.addEventListener('keydown', unlockAudio, { once: true });
    $('toast-close').addEventListener('click', hideToast);
    $('modal-home-btn').addEventListener('click', resetToHome);
    $('theme-toggle-btn').addEventListener('click', toggleTheme);
    $('sound-toggle-btn').addEventListener('click', toggleSound);
    $('sound-volume-slider').addEventListener('input', (event) => {
      setSoundVolume(Number(event.target.value) / 100);
    });
    $('menu-toggle-btn').addEventListener('click', toggleAppMenu);
    $('menu-home-btn').addEventListener('click', () => {
      closeAppMenu();
      resetToHome();
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.global-controls')) closeAppMenu();
    });

    // Screen 1: Home
    $('create-room-btn').addEventListener('click', handleCreateRoom);
    $('join-room-btn').addEventListener('click', handleJoinRoom);
    $('bot-count-select').addEventListener('change', (event) => {
      setBotCount(Number(event.target.value));
    });
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

  function unlockAudio() {
    document.removeEventListener('pointerdown', unlockAudio);
    document.removeEventListener('keydown', unlockAudio);
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) return;

    audioContext = new AudioContextConstructor();
    masterGain = audioContext.createGain();
    masterGain.gain.value = soundEnabled ? soundVolume : 0;
    masterGain.connect(audioContext.destination);
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch((error) => {
        console.error('Unable to start game audio:', error);
      });
    }
  }

  function playRajaRevealSound() {
    if (!soundEnabled || state.myRole !== 'Raja' || hasPlayedRajaRevealSound) return;

    rajaRevealAudio = playConfiguredAudio(rajaRevealAudio, GAME_SOUND_SETTINGS.rajaReveal);
    hasPlayedRajaRevealSound = true;
  }

  function stopAudio(audio) {
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;

    const timer = audioStopTimers.get(audio);
    if (timer !== undefined) {
      clearTimeout(timer);
      audioStopTimers.delete(audio);
    }
  }

  function playConfiguredAudio(audio, settings, delay = 0) {
    if (!soundEnabled) return;

    if (!audio) {
      audio = new Audio(encodeAudioPath(settings.path));
      audio.preload = 'auto';
      audio.volume = soundVolume;
    }

    const startPlayback = () => {
      if (!soundEnabled) return;
      stopAudio(audio);
      audio.play().then(() => {
        if (Number.isFinite(settings.durationSeconds) && settings.durationSeconds >= 0) {
          const timer = window.setTimeout(() => stopAudio(audio), settings.durationSeconds * 1000);
          audioStopTimers.set(audio, timer);
        }
      }).catch((error) => {
        console.error(`Unable to play audio "${settings.path}":`, error);
      });
    };

    if (delay > 0) {
      window.setTimeout(startPlayback, delay);
    } else {
      startPlayback();
    }

    return audio;
  }

  function scheduleTone(context, frequency, startAt, duration, waveform, volume, endFrequency) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = waveform;
    oscillator.frequency.setValueAtTime(frequency, startAt);
    if (endFrequency !== frequency) {
      oscillator.frequency.exponentialRampToValueAtTime(endFrequency, startAt + duration);
    }

    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

    oscillator.connect(gain);
    gain.connect(masterGain);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.02);
  }

  function playSoundEffect(effect, delay = 0) {
    if (!soundEnabled || !audioContext || audioContext.state !== 'running') return;
    const startAt = audioContext.currentTime + delay;

    if (effect === 'correct') {
      [[523, 0, 0.12], [659, 0.1, 0.12], [784, 0.2, 0.16]]
        .forEach(([frequency, offset, duration]) => {
          scheduleTone(audioContext, frequency, startAt + offset, duration, 'triangle', 0.12, frequency);
        });
    } else if (effect === 'wrong') {
      [[392, 0, 0.2], [311, 0.18, 0.22], [233, 0.38, 0.34]]
        .forEach(([frequency, offset, duration]) => {
          scheduleTone(audioContext, frequency, startAt + offset, duration, 'sawtooth', 0.07, frequency * 0.94);
        });
    } else if (effect === 'raja') {
      [[392, 0, 0.2], [494, 0.14, 0.2], [587, 0.28, 0.24], [784, 0.46, 0.42]]
        .forEach(([frequency, offset, duration]) => {
          scheduleTone(audioContext, frequency, startAt + offset, duration, 'triangle', 0.1, frequency);
          scheduleTone(audioContext, frequency * 2, startAt + offset, duration * 0.8, 'sine', 0.025, frequency * 2);
        });
    } else if (effect === 'jail') {
      scheduleTone(audioContext, 185, startAt, 0.42, 'sawtooth', 0.12, 58);
      scheduleTone(audioContext, 740, startAt, 0.28, 'square', 0.035, 280);
      scheduleTone(audioContext, 92, startAt + 0.04, 0.48, 'triangle', 0.12, 48);
    }
  }

  function updateSoundControl() {
    const volumeLevel = !soundEnabled || soundVolume === 0
      ? 'off'
      : soundVolume <= 0.3
        ? 'low'
        : soundVolume <= 0.65
          ? 'medium'
          : 'high';
    $('sound-toggle-icon').setAttribute('data-level', volumeLevel);
    $('sound-toggle-label').textContent = `Sound: ${soundEnabled ? 'On' : 'Off'}`;
    $('sound-toggle-btn').setAttribute('aria-pressed', String(soundEnabled));
    $('sound-toggle-btn').setAttribute('aria-label', soundEnabled ? 'Turn sound off' : 'Turn sound on');
    $('sound-volume-slider').value = String(Math.round(soundVolume * 100));
    $('sound-volume-value').textContent = `${Math.round(soundVolume * 100)}%`;
    if (masterGain) masterGain.gain.setTargetAtTime(soundEnabled ? soundVolume : 0, audioContext.currentTime, 0.02);
  }

  function setSoundVolume(volume) {
    const wasMutedAtZero = soundVolume === 0;
    soundVolume = Math.min(1, Math.max(0, volume));
    if (soundVolume === 0) {
      soundEnabled = false;
      [rajaRevealAudio, correctGuessAudio, wrongGuessAudio, jailAudio].forEach(stopAudio);
    } else if (wasMutedAtZero) {
      soundEnabled = true;
    }

    localStorage.setItem('rcsm_sound_enabled', String(soundEnabled));
    localStorage.setItem('rcsm_sound_volume', String(soundVolume));
    [rajaRevealAudio, correctGuessAudio, wrongGuessAudio, jailAudio]
      .filter(Boolean)
      .forEach((audio) => {
        audio.volume = soundVolume;
      });
    updateSoundControl();
  }

  function toggleSound() {
    if (!soundEnabled && soundVolume === 0) {
      setSoundVolume(DEFAULT_SOUND_VOLUME);
      return;
    }

    soundEnabled = !soundEnabled;
    localStorage.setItem('rcsm_sound_enabled', String(soundEnabled));
    if (!soundEnabled) {
      [rajaRevealAudio, correctGuessAudio, wrongGuessAudio, jailAudio].forEach(stopAudio);
    }
    updateSoundControl();
  }

  // =========================================================
  // VIEW & THEME MANAGER
  // =========================================================
  function applyTheme(isDark) {
    document.body.classList.toggle('theme-dark', isDark);
    document.body.classList.toggle('theme-light', !isDark);
    $('theme-toggle-icon').textContent = isDark ? '☀️' : '🌙';
    const themeLabel = isDark ? 'Light mode' : 'Dark mode';
    $('theme-toggle-label').textContent = themeLabel;
    $('theme-toggle-btn').setAttribute('aria-label', `Switch to ${themeLabel.toLowerCase()}`);
  }

  function toggleTheme() {
    const isDark = !document.body.classList.contains('theme-dark');
    localStorage.setItem('rcsm_theme', isDark ? 'dark' : 'light');
    applyTheme(isDark);
  }

  function toggleAppMenu() {
    const menu = $('app-menu');
    const isOpen = !menu.classList.contains('hidden');
    menu.classList.toggle('hidden', isOpen);
    $('menu-toggle-btn').setAttribute('aria-expanded', String(!isOpen));
  }

  function closeAppMenu() {
    $('app-menu').classList.add('hidden');
    $('menu-toggle-btn').setAttribute('aria-expanded', 'false');
  }

  function switchScreen(screenKey) {
    state.phase = screenKey;
    document.body.classList.toggle('chit-screen-active', screenKey === 'CHIT');
    document.body.classList.toggle('dark-screen-active', ['CHIT', 'GAME', 'RESULT'].includes(screenKey));
    Object.entries(screens).forEach(([key, el]) => {
      el.classList.toggle('active', key === screenKey);
    });

    const savedTheme = localStorage.getItem('rcsm_theme');
    if (savedTheme === 'dark' || savedTheme === 'light') {
      applyTheme(savedTheme === 'dark');
    } else {
      applyTheme(['CHIT', 'GAME', 'RESULT'].includes(screenKey));
    }
    closeAppMenu();
    persistSession();
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
    sessionAbandoned = true;
    guestReconnecting = false;
    clearTimeout(guestReconnectTimer);
    guestReconnectTimer = null;
    clearTimeout(botTurnTimeout);
    botTurnTimeout = null;
    reconnectTimers.forEach(clearTimeout);
    reconnectTimers.clear();
    const peerToDestroy = state.peer;

    if (state.isHost) {
      broadcast({ type: 'ROOM_CLOSED' });
    } else if (state.guestHostConn && state.guestHostConn.open) {
      state.guestHostConn.send({ type: 'LEAVE_SESSION', resumeId: state.sessionId });
    }

    if (peerToDestroy) {
      window.setTimeout(() => {
        try { peerToDestroy.destroy(); } catch (_) {}
      }, 100);
    }
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (error) {
      console.error('Unable to clear the saved game session:', error);
    }
    [rajaRevealAudio, correctGuessAudio, wrongGuessAudio, jailAudio].forEach(stopAudio);
    state.peer = null;
    state.isHost = false;
    state.roomCode = '';
    state.sessionId = '';
    state.myId = '';
    state.myName = '';
    state.myRole = null;
    state.players = [];
    state.hostConnections.clear();
    state.hostSecretRoles.clear();
    state.hostReadySet.clear();
    state.guestHostConn = null;
    state.round = 1;
    state.isGuessConfirmed = false;
    state.lastResult = null;
    state.suspects = [];
    state.rajaPlayer = null;
    state.sipahiPlayer = null;
    state.selectedSuspectId = null;
    state.isReady = false;
    state.isCardFlipped = false;

    $('disconnect-modal').classList.add('hidden');
    $('create-room-btn').disabled = false;
    $('join-room-btn').disabled = false;
    switchScreen('HOME');
  }

  function restoreSessionScreen() {
    if (state.phase === 'LOBBY') {
      renderLobby();
      switchScreen('LOBBY');
      return;
    }
    if (state.phase === 'CHIT' && state.myRole) {
      const savedReady = state.isReady;
      const savedFlipped = state.isCardFlipped;
      enterChitScreen();
      state.isReady = savedReady;
      state.isCardFlipped = savedFlipped && !savedReady;

      if (savedReady) {
        $('im-ready-btn').disabled = true;
        $('im-ready-btn').textContent = '⏳ Waiting for others...';
        $('ready-status-text').textContent = 'Role confirmed! Waiting for all 4 friends...';
      } else if (savedFlipped) {
        $('secret-flip-card').classList.add('is-flipped');
        $('toggle-flip-btn').textContent = '🙈 Tap to Hide';
        $('chit-instruction').textContent = 'Tap again to hide from neighbors';
        $('im-ready-btn').disabled = false;
        $('ready-status-text').textContent = 'Tap "I\'m Ready" once you\'ve seen your role';
      }

      $('ready-counter-badge').textContent = `${state.hostReadySet.size}/4 Ready`;
      persistSession();
      return;
    }
    if (state.phase === 'GAME' && state.rajaPlayer && state.sipahiPlayer) {
      const selectedSuspectId = state.selectedSuspectId;
      const guessConfirmed = state.isGuessConfirmed;
      enterGameplayScreen();
      state.selectedSuspectId = selectedSuspectId;
      state.isGuessConfirmed = guessConfirmed;
      if (selectedSuspectId) applySuspectHighlight(selectedSuspectId);
      if (guessConfirmed) $('confirm-guess-btn').disabled = true;
      persistSession();
      return;
    }
    if (state.phase === 'RESULT' && state.lastResult) {
      renderResultScreen(state.lastResult);
      return;
    }
    if (state.phase !== 'HOME') {
      showToast('Saved game data was incomplete. Rejoin the room to continue.', '⚠️');
      switchScreen('HOME');
    }
  }

  function startSessionResume() {
    sessionAbandoned = false;
    if (state.isHost) {
      showToast('Restoring your room...', '🔄');
      resumeHostPeer();
    } else {
      guestReconnecting = true;
      guestReconnectAttempt = 0;
      showToast('Reconnecting to your game...', '🔄');
      scheduleGuestReconnect();
    }
  }

  function resumeHostPeer() {
    if (sessionAbandoned) return;

    let peer;
    try {
      peer = new Peer(PEER_PREFIX + state.roomCode, PEER_CONFIG);
    } catch (error) {
      console.error('Unable to restore the host connection:', error);
      showToast('Could not reconnect as host. Please try again.', '🔌');
      return;
    }

    state.peer = peer;
    let retryScheduled = false;
    peer.on('connection', handleIncomingGuestConnection);
    peer.on('open', (id) => {
      if (state.peer !== peer || sessionAbandoned) return;
      state.myId = id;
      let hostPlayer = state.players.find((player) => player.isHost);
      if (!hostPlayer) {
        hostPlayer = {
          id,
          name: state.myName,
          isHost: true,
          score: 0,
          resumeId: state.sessionId
        };
        state.players.unshift(hostPlayer);
      } else {
        hostPlayer.id = id;
      }

      if (state.phase === 'HOME') state.phase = 'LOBBY';
      restoreSessionScreen();
      showToast(`Reconnected to room ${state.roomCode}.`, '✅');
    });
    peer.on('error', (error) => {
      if (state.peer !== peer || sessionAbandoned || retryScheduled) return;
      if (error.type === 'unavailable-id') {
        retryScheduled = true;
        try { peer.destroy(); } catch (_) {}
        window.setTimeout(resumeHostPeer, 1000);
      } else {
        console.error('Unable to restore the host connection:', error);
        showToast(`Could not restore the room: ${error.type}.`, '🔌');
      }
    });
  }

  function scheduleGuestReconnect() {
    if (sessionAbandoned || guestReconnectTimer !== null) return;
    guestReconnectTimer = window.setTimeout(() => {
      guestReconnectTimer = null;
      resumeGuestPeer();
    }, Math.min(1000 + guestReconnectAttempt * 250, 3000));
    guestReconnectAttempt = Math.min(guestReconnectAttempt + 1, 8);
  }

  function beginGuestReconnect() {
    if (sessionAbandoned) return;
    if (!guestReconnecting) {
      guestReconnecting = true;
      guestReconnectAttempt = 0;
      showToast('Connection lost. Reconnecting to your game...', '🔄');
    }
    if (state.peer) {
      try { state.peer.destroy(); } catch (_) {}
      state.peer = null;
      state.guestHostConn = null;
    }
    scheduleGuestReconnect();
  }

  function resumeGuestPeer() {
    if (sessionAbandoned) return;

    let peer;
    try {
      peer = new Peer(PEER_CONFIG);
    } catch (error) {
      console.error('Unable to reconnect to the saved game:', error);
      scheduleGuestReconnect();
      return;
    }
    state.peer = peer;
    let retryScheduled = false;

    const retry = (error) => {
      if (retryScheduled || sessionAbandoned || !guestReconnecting) return;
      retryScheduled = true;
      if (error && error.type !== 'peer-unavailable') {
        console.error('Guest reconnection attempt failed:', error);
      }
      try { peer.destroy(); } catch (_) {}
      scheduleGuestReconnect();
    };

    peer.on('open', (myId) => {
      if (state.peer !== peer || sessionAbandoned) return;
      state.myId = myId;
      const conn = peer.connect(PEER_PREFIX + state.roomCode, { reliable: true });
      state.guestHostConn = conn;

      conn.on('open', () => {
        conn.send({
          type: 'JOIN_REQUEST',
          name: state.myName,
          resumeId: state.sessionId
        });
      });
      conn.on('data', (data) => {
        handleMessageFromHost(data);
        if (data && ['RESUME_STATE', 'LOBBY_UPDATE'].includes(data.type)) {
          guestReconnecting = false;
          guestReconnectAttempt = 0;
          guestReconnectTimer = null;
        }
      });
      conn.on('close', () => {
        if (!sessionAbandoned && !retryScheduled) beginGuestReconnect();
      });
      conn.on('error', retry);
    });
    peer.on('error', retry);
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

    sessionAbandoned = false;
    state.sessionId = createSessionId();
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
      state.players = [{ id, name, isHost: true, score: 0, resumeId: state.sessionId }];
      switchScreen('LOBBY');
      renderLobby();
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
    conn.on('data', (data) => {
      if (!data || typeof data !== 'object') return;

      switch (data.type) {
        case 'JOIN_REQUEST': {
          const resumeId = String(data.resumeId || '');
          const existingPlayer = state.players.find((player) => player.resumeId && player.resumeId === resumeId);
          if (!existingPlayer && (state.players.length >= MAX_PLAYERS || state.phase !== 'LOBBY')) {
            conn.send({
              type: 'ERROR',
              message: 'Room is full or already started.'
            });
            setTimeout(() => conn.close(), 250);
            return;
          }

          const cleanName = String(data.name || 'Friend').trim().slice(0, 16) || 'Friend';
          const previousId = existingPlayer ? existingPlayer.id : null;
          if (existingPlayer) {
            const timer = reconnectTimers.get(previousId);
            if (timer !== undefined) {
              clearTimeout(timer);
              reconnectTimers.delete(previousId);
            }
            remapPeerId(previousId, conn.peer);
          } else {
            state.players.push({
              id: conn.peer,
              name: cleanName,
              isHost: false,
              score: 0,
              resumeId: resumeId || createSessionId()
            });
          }

          state.hostConnections.set(conn.peer, conn);
          conn.send(createResumeState(conn.peer));
          if (state.phase === 'LOBBY') {
            broadcastLobbyState();
            renderLobby();
          } else if (existingPlayer) {
            broadcast({
              type: 'PLAYER_RECONNECTED',
              oldId: previousId,
              player: publicPlayer(existingPlayer)
            });
          }
          persistSession();
          break;
        }

        case 'LEAVE_SESSION': {
          if (data.resumeId === state.players.find((player) => player.id === conn.peer)?.resumeId) {
            removeDisconnectedPlayer(conn.peer);
          }
          break;
        }

        case 'PLAYER_READY': {
          if (state.phase !== 'CHIT') return;
          state.hostReadySet.add(conn.peer);
          broadcastReadyCount();
          checkAllPlayersReady();
          persistSession();
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
          persistSession();
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
    state.hostConnections.delete(peerId);
    if (!state.players.some((player) => player.id === peerId) || reconnectTimers.has(peerId)) return;

    const timer = window.setTimeout(() => removeDisconnectedPlayer(peerId), PLAYER_RECONNECT_GRACE_MS);
    reconnectTimers.set(peerId, timer);
  }

  function removeDisconnectedPlayer(peerId) {
    const timer = reconnectTimers.get(peerId);
    if (timer !== undefined) {
      clearTimeout(timer);
      reconnectTimers.delete(peerId);
    }

    const leavingPlayer = state.players.find((player) => player.id === peerId);
    if (!leavingPlayer) return;
    state.hostConnections.delete(peerId);
    state.hostSecretRoles.delete(peerId);
    state.hostReadySet.delete(peerId);
    state.players = state.players.filter((player) => player.id !== peerId);
    state.suspects = state.suspects.filter((suspect) => suspect.id !== peerId);

    if (state.phase === 'LOBBY') {
      broadcastLobbyState();
      renderLobby();
      showToast(`${leavingPlayer.name} left the lobby.`, '👋');
    } else {
      broadcast({
        type: 'PLAYER_DISCONNECTED',
        name: leavingPlayer.name
      });
      showDisconnectModal(
        'Player Disconnected',
        `${leavingPlayer.name} lost connection mid-game. Return to Home to start a fresh room.`
      );
    }
    persistSession();
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
      players: state.players.map(publicPlayer)
    });
  }

  function publicPlayer(player) {
    return {
      id: player.id,
      name: player.name,
      isHost: player.isHost,
      isBot: Boolean(player.isBot),
      score: player.score
    };
  }

  function createResumeState(playerId) {
    return {
      type: 'RESUME_STATE',
      roomCode: state.roomCode,
      players: state.players.map(publicPlayer),
      phase: state.phase,
      round: state.round,
      role: state.hostSecretRoles.get(playerId) || null,
      isReady: state.hostReadySet.has(playerId),
      readyCount: state.hostReadySet.size,
      raja: state.rajaPlayer,
      sipahi: state.sipahiPlayer,
      suspects: state.suspects,
      selectedSuspectId: state.selectedSuspectId,
      result: state.lastResult
    };
  }

  function remapPeerId(oldId, newId) {
    const player = state.players.find((entry) => entry.id === oldId);
    if (!player || oldId === newId) return;

    player.id = newId;
    if (state.hostSecretRoles.has(oldId)) {
      const role = state.hostSecretRoles.get(oldId);
      state.hostSecretRoles.delete(oldId);
      state.hostSecretRoles.set(newId, role);
    }
    if (state.hostReadySet.delete(oldId)) state.hostReadySet.add(newId);
    state.hostConnections.delete(oldId);
    state.suspects = state.suspects.map((suspect) =>
      suspect.id === oldId ? { ...suspect, id: newId } : suspect
    );
    if (state.rajaPlayer?.id === oldId) state.rajaPlayer = { ...state.rajaPlayer, id: newId };
    if (state.sipahiPlayer?.id === oldId) state.sipahiPlayer = { ...state.sipahiPlayer, id: newId };
    if (state.selectedSuspectId === oldId) state.selectedSuspectId = newId;
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

    sessionAbandoned = false;
    guestReconnecting = false;
    state.sessionId = createSessionId();
    const peer = new Peer(PEER_CONFIG);
    state.peer = peer;
    state.isHost = false;
    state.roomCode = code;
    state.myName = name;
    persistSession();

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
          clearSavedSession();
          try { peer.destroy(); } catch (_) {}
        }
      }, 8000);

      conn.on('open', () => {
        clearTimeout(connectionTimeout);
        conn.send({ type: 'JOIN_REQUEST', name, resumeId: state.sessionId });
      });

      conn.on('data', (data) => {
        clearTimeout(connectionTimeout);
        handleMessageFromHost(data);
      });

      conn.on('close', () => {
        clearTimeout(connectionTimeout);
        if (state.phase !== 'HOME') beginGuestReconnect();
      });

      conn.on('error', (error) => {
        clearTimeout(connectionTimeout);
        if (state.phase === 'HOME') {
          $('join-room-btn').disabled = false;
          showToast('Could not connect to room.', '❌');
          clearSavedSession();
        } else {
          beginGuestReconnect();
        }
        console.error('Guest connection error:', error);
      });
    });

    peer.on('error', (err) => {
      clearTimeout(connectionTimeout);
      if (state.phase === 'HOME') {
        $('join-room-btn').disabled = false;
        if (err.type === 'peer-unavailable') {
          showToast(`Room "${code}" does not exist. Check the code!`, '🔍');
        } else {
          showToast(`Connection error: ${err.type}`, '🔌');
        }
        clearSavedSession();
        try { peer.destroy(); } catch (_) {}
      } else {
        beginGuestReconnect();
      }
    });
  }

  function clearSavedSession() {
    sessionAbandoned = true;
    guestReconnecting = false;
    state.sessionId = '';
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (error) {
      console.error('Unable to clear the saved game session:', error);
    }
  }

  function handleMessageFromHost(data) {
    if (!data || typeof data !== 'object') return;

    switch (data.type) {
      case 'ERROR': {
        $('join-room-btn').disabled = false;
        if (guestReconnecting) {
          guestReconnecting = false;
          sessionAbandoned = true;
          clearTimeout(guestReconnectTimer);
          guestReconnectTimer = null;
          showDisconnectModal('Could Not Reconnect', data.message || 'The saved game session is no longer available.');
          break;
        }
        showToast(data.message || 'Unable to join room.', '🚫');
        clearSavedSession();
        try { state.peer.destroy(); } catch (_) {}
        break;
      }

      case 'RESUME_STATE': {
        state.roomCode = data.roomCode;
        state.players = data.players;
        state.round = data.round;
        state.myRole = data.role || null;
        state.isReady = Boolean(data.isReady);
        state.rajaPlayer = data.raja || null;
        state.sipahiPlayer = data.sipahi || null;
        state.suspects = Array.isArray(data.suspects) ? data.suspects : [];
        state.selectedSuspectId = data.selectedSuspectId || null;
        state.lastResult = data.result || null;
        state.phase = data.phase;
        restoreSessionScreen();
        if (state.phase === 'CHIT') {
          $('ready-counter-badge').textContent = `${data.readyCount}/4 Ready`;
        }
        persistSession();
        break;
      }

      case 'LOBBY_UPDATE': {
        state.roomCode = data.roomCode;
        state.players = data.players;
        renderLobby();
        if (state.phase !== 'LOBBY') {
          switchScreen('LOBBY');
        }
        persistSession();
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
        persistSession();
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
        persistSession();
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

      case 'PLAYER_RECONNECTED': {
        state.players = state.players.map((player) =>
          player.id === data.oldId ? { ...player, ...data.player } : player
        );
        state.suspects = state.suspects.map((suspect) =>
          suspect.id === data.oldId ? { ...suspect, id: data.player.id } : suspect
        );
        if (state.rajaPlayer?.id === data.oldId) state.rajaPlayer = { ...state.rajaPlayer, id: data.player.id };
        if (state.sipahiPlayer?.id === data.oldId) state.sipahiPlayer = { ...state.sipahiPlayer, id: data.player.id };
        if (state.selectedSuspectId === data.oldId) state.selectedSuspectId = data.player.id;
        persistSession();
        break;
      }

      case 'ROOM_CLOSED': {
        sessionAbandoned = true;
        guestReconnecting = false;
        clearTimeout(guestReconnectTimer);
        guestReconnectTimer = null;
        showDisconnectModal('Room Closed', 'The host ended the game session.');
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
    const botCount = state.players.filter((player) => player.isBot).length;
    const humanCount = count - botCount;
    $('player-count-badge').textContent = `${count} / 4`;
    $('host-bot-controls').classList.toggle('hidden', !state.isHost);
    $('bot-count-select').disabled = !state.isHost || state.phase !== 'LOBBY';
    $('bot-count-select').value = String(botCount);
    Array.from($('bot-count-select').options).forEach((option) => {
      option.disabled = Number(option.value) > MAX_PLAYERS - humanCount;
    });

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
            <span class="slot-avatar">${p.isBot ? '🤖' : '👤'}</span>
            <span>${escapeHtml(p.name)}</span>
            ${p.isHost ? '<span class="host-tag">👑 Host</span>' : ''}
            ${p.isBot ? '<span class="bot-tag">Bot</span>' : ''}
            ${p.id === state.myId ? '<span class="host-tag" style="background:#059669;">You</span>' : ''}
          </div>
          <span class="joined-tag">${p.isBot ? '🤖 Ready' : '✔ Joined'}</span>
        `;
      } else {
        row.className = 'slot-row empty';
        row.innerHTML = `
          <div class="slot-left">
            <span class="slot-avatar">👤</span>
            <span>Waiting for player...</span>
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

  function setBotCount(requestedCount) {
    if (!state.isHost || state.phase !== 'LOBBY') return;

    const humans = state.players.filter((player) => !player.isBot);
    const maxBotCount = MAX_PLAYERS - humans.length;
    const targetCount = Math.max(0, Math.min(maxBotCount, requestedCount));
    const bots = state.players.filter((player) => player.isBot).slice(0, targetCount);

    while (bots.length < targetCount) {
      const botNumber = bots.length + 1;
      bots.push({
        id: `bot-${createSessionId()}`,
        name: `Bot ${botNumber}`,
        isHost: false,
        isBot: true,
        score: 0
      });
    }

    state.players = [...humans, ...bots];
    renderLobby();
    broadcastLobbyState();
    persistSession();
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
    state.lastResult = null;
    state.isGuessConfirmed = false;

    const shuffledRoles = cryptoShuffle(ROLES);

    // Assign roles strictly on Host and send ONLY each peer's own secret role
    state.players.forEach((player, idx) => {
      const assignedRole = shuffledRoles[idx];
      state.hostSecretRoles.set(player.id, assignedRole);

      if (player.isBot) {
        state.hostReadySet.add(player.id);
      } else if (player.id === state.myId) {
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
    broadcastReadyCount();
  }

  function enterChitScreen() {
    state.isCardFlipped = false;
    state.isReady = false;
    hasPlayedRajaRevealSound = false;

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
      playRajaRevealSound();
      if (!state.isReady) {
        $('im-ready-btn').disabled = false;
        $('ready-status-text').textContent = 'Tap "I\'m Ready" once you\'ve seen your role';
      }
    } else {
      $('toggle-flip-btn').textContent = '👁️ Tap to Reveal';
      $('chit-instruction').textContent = 'Chit hidden! Tap to peek again';
    }
    persistSession();
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
    persistSession();
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
    playSoundEffect('raja');
    state.isGuessConfirmed = false;
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
    if (state.isHost) runBotSipahiTurn();
  }

  function runBotSipahiTurn() {
    const botSipahi = state.players.find((player) => player.id === state.sipahiPlayer?.id && player.isBot);
    if (!botSipahi || state.suspects.length === 0) return;

    clearTimeout(botTurnTimeout);
    const round = state.round;
    const guess = cryptoShuffle(state.suspects)[0];
    botTurnTimeout = window.setTimeout(() => {
      if (state.phase !== 'GAME' || state.round !== round) return;
      state.selectedSuspectId = guess.id;
      applySuspectHighlight(guess.id);
      broadcast({ type: 'SUSPECT_HIGHLIGHTED', targetId: guess.id });
      persistSession();

      botTurnTimeout = window.setTimeout(() => {
        if (state.phase !== 'GAME' || state.round !== round) return;
        state.isGuessConfirmed = true;
        hostResolveRound(guess.id);
      }, 900);
    }, 1200);
  }

  function handleSuspectTap(index) {
    if (state.myRole !== 'Sipahi') return;
    const suspect = state.suspects[index];
    if (!suspect) return;

    state.selectedSuspectId = suspect.id;
    applySuspectHighlight(suspect.id);
    $('confirm-guess-btn').disabled = false;
    persistSession();

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
    state.isGuessConfirmed = true;
    persistSession();

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
      players: state.players.map(publicPlayer),
      breakdown: roundBreakdown
    };

    state.lastResult = resultPayload;
    broadcast(resultPayload);
    renderResultScreen(resultPayload);
  }

  function renderResultScreen(data) {
    state.lastResult = data;
    const { round, isCorrect, breakdown } = data;
    playSoundEffect(isCorrect ? 'correct' : 'wrong');
    if (isCorrect) {
      correctGuessAudio = playConfiguredAudio(correctGuessAudio, GAME_SOUND_SETTINGS.correctGuess);
      jailAudio = playConfiguredAudio(jailAudio, GAME_SOUND_SETTINGS.jail, 360);
      playSoundEffect('jail', 0.36);
    } else {
      wrongGuessAudio = playConfiguredAudio(wrongGuessAudio, GAME_SOUND_SETTINGS.wrongGuess);
    }
    $('result-round-badge').textContent = `Round ${round} Result`;

    const ribbon = $('outcome-banner');
    const jailStage = $('jail-stage');
    const jailBars = $('jail-bars');

    jailStage.classList.remove('outcome-correct', 'outcome-wrong');
    void jailStage.offsetWidth;
    jailStage.classList.add(isCorrect ? 'outcome-correct' : 'outcome-wrong');

    // Re-trigger CSS drop animation cleanly
    jailBars.style.animation = 'none';
    void jailBars.offsetWidth;
    jailBars.style.animation = '';

    const chorEntry = breakdown.find((b) => b.role === 'Chor');
    const sipahiEntry = breakdown.find((b) => b.role === 'Sipahi');

    if (isCorrect) {
      // Outcome A: Sipahi Catches Chor
      $('action-raja').textContent = '👑';
      $('action-chor').textContent = '🦹😰';
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
      $('action-raja').textContent = '👑😠';
      $('action-chor').textContent = '🦹😄';
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
