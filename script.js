// ============================================================
// Wotchly — Room Script (v2)
// Host Control Panel · Host-only controls · Perfect sync
// Mute button · Landscape mode · PWA/keyboard fixes
// Background playback resync · Firebase listener cleanup
// ============================================================

// Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}

import { db, ref, set, get, push, update, remove, onValue, onDisconnect } from './firebase.js';
import Hls from 'hls.js';
import { searchAnime, getAnimeEpisodes, getAnimeStreamUrl, resolveOttEmbed, resolveAnimeMovieUrl, extractTitleFromOttUrl, EMBED_PROVIDERS, DEFAULT_PROVIDER } from './streamResolver.js';

// ---- URL params ----
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('room');
let username = urlParams.get('user') || localStorage.getItem('wotchly_username') || '';
let userId = localStorage.getItem('wotchly_userId') || 'usr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);

// ---- Constants ----
const MAX_USERS_PER_ROOM = 50;
const SYNC_THRESHOLD = 2;        // seconds — only resync if drift exceeds this
const MAX_FORWARD_JUMP = 30;     // seconds — cap forward jumps to avoid wild seeks
const SYNC_INTERVAL_MS = 3000;   // host broadcasts every 3s

const ACCENT_COLORS = [
  '#C7B8FF','#FF6B6B','#4ECDC4','#45B7D1','#96CEB4',
  '#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE',
  '#F8B500','#FF69B4','#00CED1','#FFD700','#32CD32',
  '#FF4500','#1E90FF','#FF1493','#00FA9A','#FFA07A'
];

const USER_COLORS = [
  '#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7',
  '#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#85C1E9',
  '#F8B500','#FF69B4','#00CED1','#FFD700','#32CD32',
  '#FF4500','#1E90FF','#FF1493','#00FA9A','#FFA07A'
];

function getUserColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return USER_COLORS[Math.abs(h) % USER_COLORS.length];
}

// ---- State ----
let isHost = false;
let currentVideoType = null;
let videoPlayer = null;
let hlsInstance = null;
let youtubePlayer = null;
let ytReady = false;
let isSeeking = false;
let syncInterval = null;
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let userCount = 0;
let currentMode = 'player';
let browserIframe = null;
let isVideoMuted = false;
let isRoomLocked = false;
let cachedUsers = {};
let currentHostId = null;
let currentVideoUrl = '';
let currentMovieId  = null; // MovieBox: ID of the currently-playing title (set only after stream loads)
let _movieLoadVersion = 0;  // Increments on every new MovieBox selection; stale loads check this
let _unreadCount = 0;
window._unreadCount = 0;
let currentAccentColor = '#C7B8FF';

// ---- Firebase listener references (for cleanup) ----
let roomListenerUnsubscribe = null;
let chatListenerUnsubscribe = null;
let presenceListenerUnsubscribe = null;

// ---- Last room snapshot (used for Drive subtitle timing) ----
let lastRoomData = null;

// ---- Drive subtitle overlay state ----
let driveVttCues = [];
let driveSubInterval = null;

// ---- System pause detection ----
let userInitiatedPause = false;
let wasPlayingBeforeHidden = false;
let systemPauseResumeTimer = null;
let isManuallyPaused = false;
const SYSTEM_PAUSE_RESUME_DELAY = 300;

// ---- Initial join sync ----
// Stores the Firebase snapshot captured at join time so it can be applied
// the moment the player signals it is ready (loadedmetadata / onReady).
// Without this, seeks called before the player is ready silently fail
// and the new guest starts from 0 instead of the host's position.
let pendingInitialSync = null;

// ---- Audio engine ----
let audioSettings = JSON.parse(localStorage.getItem('wotchly_audio_settings') || 'null') || {
  volume: 100, bass: 50, treble: 50, balance: 50, equalizerPreset: 'normal'
};
let audioContext = null, bassFilter = null, trebleFilter = null;
let gainNode = null, balancePanner = null;
let currentAudioSource = null, currentMediaElement = null;
let audioContextInitialized = false;

// ---- Music embed state ----
let currentMusicEmbed = null;
let musicEmbedType = null;

// ---- Background playback ----
let backgroundPlaybackInterval = null;
let lastKnownPlayingState = false;
let lastKnownCurrentTime = 0;
let mediaSessionInitialized = false;
let audioInterruptionInProgress = false;
let currentQuality = 'auto';

// ---- Silent audio keepalive ----
// Plays an inaudible loop so Chrome/Android keeps the audio session open
// even when the tab is hidden or the app is switched.
let _silentAudio = null;
function _buildSilentAudio() {
  if (_silentAudio) return _silentAudio;
  try {
    // Build a minimal WAV: 0.1 s of silence at 8 kHz, 8-bit mono
    const numSamples = 800;
    const buf = new ArrayBuffer(44 + numSamples);
    const v = new DataView(buf);
    const ascii = (s, off) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
    ascii('RIFF', 0); v.setUint32(4, 36 + numSamples, true);
    ascii('WAVE', 8); ascii('fmt ', 12);
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
    v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    ascii('data', 36); v.setUint32(40, numSamples, true);
    for (let i = 0; i < numSamples; i++) v.setUint8(44 + i, 128); // 128 = silence for u8 PCM
    const blob = new Blob([buf], { type: 'audio/wav' });
    _silentAudio = new Audio(URL.createObjectURL(blob));
    _silentAudio.loop = true;
    _silentAudio.volume = 0.001; // inaudible
  } catch {}
  return _silentAudio;
}
function startSilentAudio() {
  const a = _buildSilentAudio();
  if (a && a.paused) a.play().catch(() => {});
}
function stopSilentAudio() {
  if (_silentAudio && !_silentAudio.paused) { _silentAudio.pause(); _silentAudio.currentTime = 0; }
}

// iOS Safari requires audio to be started (play + immediate pause) inside a
// user-gesture handler. This unlocks the audio element so it can be freely
// started/stopped later — even when the screen locks or the app is backgrounded.
(function _prewarmSilentAudio() {
  const unlock = () => {
    const a = _buildSilentAudio();
    if (a) {
      // iOS: actually play then pause to register the audio element with the
      // system audio session. Without this, iOS will block any future .play()
      // calls that happen outside a user gesture (e.g. from visibilitychange).
      a.play().then(() => {
        // Brief play is enough to unlock — pause immediately so it's silent.
        // Do NOT stop it fully; keep it "unlocked but paused".
      }).catch(() => {});
    }
    // Also resume any pre-created AudioContext in the gesture window.
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
  };
  document.addEventListener('touchstart',  unlock, { once: true, capture: true, passive: true });
  document.addEventListener('pointerdown', unlock, { once: true, capture: true, passive: true });
  document.addEventListener('click',       unlock, { once: true, capture: true });
  document.addEventListener('keydown',     unlock, { once: true, capture: true });
})();

// Generates a canvas-based PNG for MediaSession artwork.
// iOS Safari does NOT accept SVG data URIs as MediaMetadata artwork.
function _getMediaArtworkPng() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // Rounded background — #C7B8FF
    const r = 72;
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.lineTo(512-r, 0); ctx.quadraticCurveTo(512, 0, 512, r);
    ctx.lineTo(512, 512-r); ctx.quadraticCurveTo(512, 512, 512-r, 512);
    ctx.lineTo(r, 512); ctx.quadraticCurveTo(0, 512, 0, 512-r);
    ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fillStyle = '#C7B8FF';
    ctx.fill();
    // Play triangle — #1a1a2e
    ctx.beginPath();
    ctx.moveTo(168, 136); ctx.lineTo(384, 256); ctx.lineTo(168, 376);
    ctx.closePath();
    ctx.fillStyle = '#1a1a2e';
    ctx.fill();
    return canvas.toDataURL('image/png');
  } catch { return null; }
}

// ---- Language / Audio track selector state ----
let availableAudioTracks = [];
let availableSubtitleTracks = [];
let currentAudioTrackId = -1;
let currentSubtitleTrackId = -1;
let currentEmbedLang    = localStorage.getItem('wotchly_embed_lang')     || 'hi';   // active audio/dub lang for iframe embeds (default: Hindi dub)
let currentEmbedSubLang = localStorage.getItem('wotchly_embed_sub_lang') || null;   // active subtitle lang for iframe embeds ('off' = disabled)
let isEmbedLangMode = false;   // true when lang selector is showing embed languages
let embedPlayStartTime = null; // wall-clock when iframe play was last triggered
let embedCurrentOffset = 0;   // estimated playback offset (seconds) for iframe seek


// ============================================================
// USERNAME GATE
// ============================================================

function initUsernameGate() {
  if (!roomId) {
    window.location.href = 'index.html';
    return;
  }

  const gate = document.getElementById('usernameGate');
  const roomWrapper = document.getElementById('roomWrapper');

  const gateCode = document.getElementById('gateRoomCodeText');
  if (gateCode) gateCode.textContent = roomId;
  const gateCodeDisplay = document.getElementById('roomCodeDisplay');
  if (gateCodeDisplay) gateCodeDisplay.textContent = roomId;

  // Theme toggle on gate
  const gateThemeToggle = document.getElementById('themeToggleGate');
  if (gateThemeToggle) {
    gateThemeToggle.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'light' ? 'dark' : 'light';
      localStorage.setItem('wotchly_theme', next);
      applyTheme(next);
    });
  }
  applyTheme(localStorage.getItem('wotchly_theme') || 'dark');

  // If we have a username skip the gate
  if (username) {
    localStorage.setItem('wotchly_userId', userId);
    localStorage.setItem('wotchly_username', username);
    if (gate) gate.style.display = 'none';
    if (roomWrapper) roomWrapper.style.display = 'flex';
    initRoom();
    return;
  }

  if (gate) gate.style.display = 'flex';
  if (roomWrapper) roomWrapper.style.display = 'none';

  const gateInput = document.getElementById('gateUsername');
  const gateBtn = document.getElementById('gateJoinBtn');

  function enterRoom() {
    const name = gateInput ? gateInput.value.trim() : '';
    if (!name) {
      showNotification('Enter your name to join', 'error');
      if (gateInput) gateInput.focus();
      return;
    }
    username = name;
    userId = 'usr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    localStorage.setItem('wotchly_userId', userId);
    localStorage.setItem('wotchly_username', username);

    if (gate) { gate.style.opacity = '0'; gate.style.transition = 'opacity .3s'; setTimeout(() => gate.style.display = 'none', 300); }
    if (roomWrapper) { roomWrapper.style.display = 'flex'; roomWrapper.style.opacity = '0'; roomWrapper.style.transition = 'opacity .3s'; setTimeout(() => roomWrapper.style.opacity = '1', 10); }

    initRoom();
  }

  if (gateBtn) gateBtn.addEventListener('click', enterRoom);
  if (gateInput) gateInput.addEventListener('keydown', e => { if (e.key === 'Enter') enterRoom(); });

  const savedName = localStorage.getItem('wotchly_username');
  if (savedName && gateInput) gateInput.value = savedName;
}

// ============================================================
// AUDIO ENGINE
// ============================================================

function initAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    bassFilter = audioContext.createBiquadFilter();
    bassFilter.type = 'lowshelf';
    bassFilter.frequency.value = 200;
    trebleFilter = audioContext.createBiquadFilter();
    trebleFilter.type = 'highshelf';
    trebleFilter.frequency.value = 3000;
    gainNode = audioContext.createGain();
    balancePanner = audioContext.createStereoPanner();
    bassFilter.connect(trebleFilter);
    trebleFilter.connect(balancePanner);
    balancePanner.connect(gainNode);
    gainNode.connect(audioContext.destination);
    audioContextInitialized = true;
    // iOS creates AudioContext in 'suspended' state even when called from a
    // user-gesture handler. Immediately resume so audio flows from the start.
    audioContext.resume().catch(() => {});
    // Auto-resume whenever browser suspends the context (tab/app switch)
    audioContext.onstatechange = () => {
      if (audioContext.state === 'suspended' && lastKnownPlayingState && !isManuallyPaused) {
        audioContext.resume().catch(() => {});
      }
    };
  }
  return audioContext;
}

function connectMediaToAudioContext(mediaElement) {
  // Only connect when actually needed (non-default EQ settings).
  // createMediaElementSource() permanently captures all audio through the
  // AudioContext chain. If AudioContext suspends in background (Chrome always
  // does), NO audio comes out — even if the video is still "playing".
  // Skipping the connection lets native browser audio work in background.
  if (!mediaElement) return;
  const needsEq = audioSettings.bass !== 50
    || audioSettings.treble !== 50
    || audioSettings.balance !== 50;
  if (!needsEq) return; // native audio — background-safe
  try {
    initAudioContext();
    if (audioContext.state === 'suspended') audioContext.resume();
    if (currentMediaElement === mediaElement && currentAudioSource) { applyEqualizerToAudio(); return; }
    if (currentAudioSource) { try { currentAudioSource.disconnect(); } catch (e) {} }
    currentMediaElement = mediaElement;
    if (!mediaElement._audioSourceCreated) {
      currentAudioSource = audioContext.createMediaElementSource(mediaElement);
      mediaElement._audioSourceCreated = true;
      currentAudioSource.connect(bassFilter);
    }
    applyEqualizerToAudio();
  } catch (e) { console.log('Audio context:', e.message); }
}

function applyEqualizerToAudio() {
  if (!audioContext || !bassFilter || !trebleFilter || !balancePanner || !gainNode) return;
  try {
    bassFilter.gain.setValueAtTime(((audioSettings.bass - 50) / 50) * 25, audioContext.currentTime);
    trebleFilter.gain.setValueAtTime(((audioSettings.treble - 50) / 50) * 25, audioContext.currentTime);
    balancePanner.pan.setValueAtTime((audioSettings.balance - 50) / 50, audioContext.currentTime);
    gainNode.gain.setValueAtTime(audioSettings.volume / 100, audioContext.currentTime);
  } catch (e) {}
}

function applyAudioSettings() {
  const vol = audioSettings.volume / 100;
  if (videoPlayer) videoPlayer.volume = vol;
  if (youtubePlayer && ytReady && typeof youtubePlayer.setVolume === 'function') youtubePlayer.setVolume(audioSettings.volume);
  document.querySelectorAll('audio').forEach(a => { a.volume = vol; });
  localStorage.setItem('wotchly_audio_settings', JSON.stringify(audioSettings));
}

function applyEqualizerPreset(preset) {
  const presets = {
    normal: { bass: 50, treble: 50 }, bass_boost: { bass: 80, treble: 40 },
    treble_boost: { bass: 40, treble: 80 }, vocal: { bass: 45, treble: 60 },
    rock: { bass: 70, treble: 65 }, jazz: { bass: 55, treble: 70 },
    classical: { bass: 45, treble: 55 }, electronic: { bass: 75, treble: 75 }
  };
  if (presets[preset]) {
    audioSettings.bass = presets[preset].bass;
    audioSettings.treble = presets[preset].treble;
    const bs = document.getElementById('bassSlider'), ts = document.getElementById('trebleSlider');
    if (bs) { bs.value = audioSettings.bass; const bv = document.getElementById('bassValue'); if (bv) bv.textContent = audioSettings.bass + '%'; }
    if (ts) { ts.value = audioSettings.treble; const tv = document.getElementById('trebleValue'); if (tv) tv.textContent = audioSettings.treble + '%'; }
  }
}

function initializeAudioSettings() {
  const volumeSlider = document.getElementById('volumeSlider');
  const bassSlider = document.getElementById('bassSlider');
  const trebleSlider = document.getElementById('trebleSlider');
  const balanceSlider = document.getElementById('balanceSlider');
  const eqPreset = document.getElementById('equalizerPreset');

  if (volumeSlider) {
    volumeSlider.value = audioSettings.volume;
    volumeSlider.oninput = e => {
      audioSettings.volume = +e.target.value;
      applyAudioSettings(); applyEqualizerToAudio();
      const el = document.getElementById('volumeValue'); if (el) el.textContent = audioSettings.volume + '%';
    };
  }
  if (bassSlider) {
    bassSlider.value = audioSettings.bass;
    bassSlider.oninput = e => {
      audioSettings.bass = +e.target.value; applyEqualizerToAudio();
      const el = document.getElementById('bassValue'); if (el) el.textContent = audioSettings.bass + '%';
    };
  }
  if (trebleSlider) {
    trebleSlider.value = audioSettings.treble;
    trebleSlider.oninput = e => {
      audioSettings.treble = +e.target.value; applyEqualizerToAudio();
      const el = document.getElementById('trebleValue'); if (el) el.textContent = audioSettings.treble + '%';
    };
  }
  if (balanceSlider) {
    balanceSlider.value = audioSettings.balance;
    balanceSlider.oninput = e => {
      audioSettings.balance = +e.target.value; applyEqualizerToAudio();
      const val = audioSettings.balance;
      const el = document.getElementById('balanceValue');
      if (el) el.textContent = val < 50 ? 'L' + (50-val) : val > 50 ? 'R' + (val-50) : 'C';
    };
  }
  if (eqPreset) {
    eqPreset.value = audioSettings.equalizerPreset;
    eqPreset.onchange = e => { audioSettings.equalizerPreset = e.target.value; applyEqualizerPreset(e.target.value); applyEqualizerToAudio(); };
  }

  const vv = document.getElementById('volumeValue'); if (vv) vv.textContent = audioSettings.volume + '%';
  const bv = document.getElementById('bassValue'); if (bv) bv.textContent = audioSettings.bass + '%';
  const tv = document.getElementById('trebleValue'); if (tv) tv.textContent = audioSettings.treble + '%';
  const bav = document.getElementById('balanceValue');
  if (bav) {
    const val = audioSettings.balance;
    bav.textContent = val < 50 ? 'L' + (50-val) : val > 50 ? 'R' + (val-50) : 'C';
  }
}

// ============================================================
// URL DETECTION & GOOGLE DRIVE
// ============================================================

function convertGoogleDriveUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('drive.google.com')) return url;
    const fileMatch = u.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (fileMatch) return `https://drive.google.com/uc?export=download&id=${fileMatch[1]}`;
    const idParam = u.searchParams.get('id');
    if (idParam) return `https://drive.google.com/uc?export=download&id=${idParam}`;
  } catch {}
  return url;
}

function detectVideoType(url) {
  if (!url) return null;
  if (url.includes('youtube.com/embed') || url.includes('youtube-nocookie.com/embed')) return 'youtube';
  if (url.includes('youtube.com/watch') || url.includes('youtu.be') || url.includes('youtube.com/shorts')) return 'youtube-url';
  if (url.includes('vimeo.com')) return 'vimeo';
  if (url.includes('dailymotion.com') || url.includes('dai.ly')) return 'dailymotion';
  if (url.match(/\.(mp4|webm|ogg|mov)(\?|$)/i)) return 'direct';
  if (url.match(/\.(m3u8)(\?|$)/i)) return 'hls';
  if (url.match(/\.(mp3|wav|flac|aac|m4a|ogg)(\?|$)/i)) return 'audio';
  if (url.includes('drive.google.com')) return 'drive';
  // Embed providers — must be a clean iframe, NOT a sandboxed browser frame
  if (url.includes('vidsrc.') || url.includes('2embed.') || url.includes('multiembed.') ||
      url.includes('embed.su') || url.includes('autoembed.co') || url.includes('vidlink.pro') ||
      url.includes('moviesapi.') || url.includes('smashystream.') || url.includes('/embed/movie/') ||
      url.includes('/embed/tv/')) return 'embed';
  if (url.startsWith('http://') || url.startsWith('https://')) return 'website';
  return 'direct';
}

function isVideoUrl(url) {
  if (!url) return false;
  const t = detectVideoType(url);
  return ['youtube','youtube-url','vimeo','dailymotion','direct','hls','drive','audio'].includes(t);
}

function isBrowserUrl(url) { return detectVideoType(url) === 'website'; }

function isMusicStreamingSite(url) {
  if (!url) return false;
  const ALLOWED = ['open.spotify.com','spotify.com','music.youtube.com','www.jiosaavn.com','jiosaavn.com','www.saavn.com','saavn.com','gaana.com','www.gaana.com','soundcloud.com','www.soundcloud.com','w.soundcloud.com'];
  try { return ALLOWED.includes(new URL(url).hostname.toLowerCase()); } catch { return false; }
}

function extractYouTubeId(url) {
  if (url.includes('youtube.com/watch')) return new URL(url).searchParams.get('v');
  if (url.includes('youtu.be/')) return url.split('youtu.be/')[1]?.split('?')[0];
  if (url.includes('youtube.com/embed/')) return url.split('embed/')[1]?.split('?')[0];
  if (url.includes('youtube.com/shorts/')) return url.split('shorts/')[1]?.split('?')[0];
  return null;
}

function extractVimeoId(url) { return url.match(/vimeo\.com\/(?:video\/)?(\d+)/)?.[1] || null; }
function extractDailymotionId(url) { return (url.match(/dailymotion\.com\/video\/([a-zA-Z0-9]+)/) || url.match(/dai\.ly\/([a-zA-Z0-9]+)/))?.[1] || null; }

// ============================================================
// MUSIC EMBEDS
// ============================================================

const ALLOWED_EMBED_HOSTS = ['open.spotify.com','w.soundcloud.com','www.youtube.com','youtube.com','www.jiosaavn.com','jiosaavn.com','gaana.com','www.gaana.com'];

function getMusicEmbedUrl(url) {
  try {
    const urlObj = new URL(url), h = urlObj.hostname.toLowerCase(), p = urlObj.pathname;
    if (h.includes('spotify.com')) {
      return { embedUrl: p.includes('/embed/') ? url : `https://open.spotify.com/embed${p}?utm_source=generator&theme=0`, embedType: 'spotify' };
    }
    if (h.includes('soundcloud.com')) {
      return { embedUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=false&hide_related=true&show_comments=false&visual=true&color=%23C7B8FF`, embedType: 'soundcloud' };
    }
    if (h.includes('music.youtube.com')) {
      const v = urlObj.searchParams.get('v');
      if (v) return { embedUrl: `https://www.youtube.com/embed/${v}?autoplay=0`, embedType: 'youtube-music' };
      const list = urlObj.searchParams.get('list');
      if (list) return { embedUrl: `https://www.youtube.com/embed/videoseries?list=${list}&autoplay=0`, embedType: 'youtube-music' };
    }
    if (h.includes('jiosaavn.com') || h.includes('saavn.com')) {
      if (p.includes('/song/')) return { embedUrl: `https://www.jiosaavn.com${p.replace('/song/','/embed/song/')}`, embedType: 'jiosaavn' };
    }
    if (h.includes('gaana.com')) {
      const parts = p.split('/'), idx = parts.indexOf('song');
      if (idx !== -1 && parts[idx+1]) return { embedUrl: `https://gaana.com/embed/song/${parts[idx+1]}`, embedType: 'gaana' };
    }
  } catch {}
  return { embedUrl: null, embedType: null };
}

function isAllowedEmbedHost(embedUrl) {
  try { return ALLOWED_EMBED_HOSTS.includes(new URL(embedUrl).hostname.toLowerCase()); } catch { return false; }
}

function createMusicEmbedPlayer(embedUrl, embedType, originalUrl) {
  if (!isAllowedEmbedHost(embedUrl)) return null;
  if (currentMusicEmbed) { currentMusicEmbed.remove(); currentMusicEmbed = null; }

  const wrapper = document.createElement('div');
  wrapper.className = 'music-embed-wrapper';
  wrapper.dataset.embedType = embedType;

  const iframe = document.createElement('iframe');
  iframe.className = 'music-embed-iframe';
  iframe.dataset.embedType = embedType;

  const sizes = { spotify: '352px', soundcloud: '300px', 'youtube-music': '352px', jiosaavn: '200px', gaana: '200px' };
  iframe.style.cssText = `width:100%;max-width:600px;height:${sizes[embedType]||'300px'};border:0;border-radius:12px;`;
  iframe.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';

  wrapper.appendChild(iframe);
  iframe.src = embedUrl;
  currentMusicEmbed = wrapper;
  musicEmbedType = embedType;
  return wrapper;
}

function attemptMusicEmbedResume() {
  if (!currentMusicEmbed) return;
  const iframe = currentMusicEmbed.querySelector('iframe');
  if (!iframe?.contentWindow) return;
  try {
    if (musicEmbedType === 'spotify') iframe.contentWindow.postMessage({ command: 'toggle' }, '*');
    else if (musicEmbedType === 'soundcloud') iframe.contentWindow.postMessage(JSON.stringify({ method: 'play' }), '*');
    else if (musicEmbedType === 'youtube-music') iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'playVideo', args: [] }), '*');
  } catch {}
}

function attemptIframeResume() {
  const vi = document.getElementById('vimeoPlayer');
  if (vi?.contentWindow) try { vi.contentWindow.postMessage(JSON.stringify({ method: 'play' }), '*'); } catch {}
  const di = document.getElementById('dailymotionPlayer');
  if (di?.contentWindow) try { di.contentWindow.postMessage(JSON.stringify({ command: 'play' }), '*'); } catch {}
}

/**
 * Send a playback command to any active iframe player via postMessage.
 * Tries multiple message formats used by common embed players.
 * @param {'play'|'pause'|'seek'} command
 * @param {number|null} seekTo  seconds (for seek command)
 * @returns {boolean} true if any iframe was found
 */
function sendIframeCommand(command, seekTo = null) {
  const IFRAME_IDS = ['embedFrame', 'ottEmbedFrame', 'driveFrame', 'vimeoPlayer', 'dailymotionPlayer'];
  let sent = false;
  for (const id of IFRAME_IDS) {
    const iframe = document.getElementById(id);
    if (!iframe?.contentWindow) continue;
    sent = true;
    const win = iframe.contentWindow;
    // Vimeo-specific
    if (id === 'vimeoPlayer') {
      try { win.postMessage(JSON.stringify({ method: command === 'play' ? 'play' : command === 'pause' ? 'pause' : 'setCurrentTime', value: seekTo }), '*'); } catch {}
      continue;
    }
    // Dailymotion-specific
    if (id === 'dailymotionPlayer') {
      const dmCmd = command === 'play' ? 'play' : command === 'pause' ? 'pause' : 'seek';
      try { win.postMessage(JSON.stringify({ command: dmCmd, parameters: seekTo != null ? [seekTo] : [] }), '*'); } catch {}
      continue;
    }
    // Generic embed iframes — try all common postMessage formats
    // Format 1: plain object {action}
    try { win.postMessage({ action: command, ...(seekTo != null ? { position: seekTo, time: seekTo } : {}) }, '*'); } catch {}
    // Format 2: Plyr
    try { win.postMessage({ source: 'plyr', command, ...(seekTo != null ? { seekTime: seekTo } : {}) }, '*'); } catch {}
    // Format 3: stringified {action}
    try { win.postMessage(JSON.stringify({ action: command, ...(seekTo != null ? { position: seekTo } : {}) }), '*'); } catch {}
    // Format 4: {event} style
    try { win.postMessage({ event: command }, '*'); } catch {}
    // Format 5: Video.js / JW Player
    try { win.postMessage({ command, value: seekTo }, '*'); } catch {}
    // Format 6: {type} style — very common in custom players
    try { win.postMessage({ type: command, ...(seekTo != null ? { time: seekTo, position: seekTo } : {}) }, '*'); } catch {}
    // Format 7: YouTube iframe API style (some embeds mimic YT API)
    if (command === 'play')  try { win.postMessage(JSON.stringify({ event: 'command', func: 'playVideo',  args: [] }), '*'); } catch {}
    if (command === 'pause') try { win.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), '*'); } catch {}
    if (command === 'seek' && seekTo != null) try { win.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [seekTo, true] }), '*'); } catch {}
    // Format 8: stringified {type}
    try { win.postMessage(JSON.stringify({ type: command, ...(seekTo != null ? { time: seekTo } : {}) }), '*'); } catch {}
    // Format 9: vidlink / autoembed / vidsrc generic API
    try { win.postMessage({ api: command, ...(seekTo != null ? { seconds: seekTo, time: seekTo } : {}) }, '*'); } catch {}
    // Format 10: player control object
    try { win.postMessage({ player: 'wotchly', command, ...(seekTo != null ? { seek: seekTo } : {}) }, '*'); } catch {}
    // Keyboard simulation — focus the iframe then dispatch Space key.
    // Some cross-origin players respect keyboard events when their iframe has focus.
    if (command === 'play' || command === 'pause') {
      try {
        iframe.focus();
        iframe.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true }));
        iframe.dispatchEvent(new KeyboardEvent('keyup',   { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true }));
      } catch {}
    }
  }
  return sent;
}

// ============================================================
// MODE INDICATOR
// ============================================================

function updateModeIndicator(mode, sourceType = null) {
  currentMode = mode;
  const indicator = document.getElementById('modeIndicator');
  const icon = document.getElementById('modeIcon');
  const text = document.getElementById('modeText');
  if (!indicator || !icon || !text) return;

  indicator.className = `mode-indicator visible mode-${mode}`;

  const icons = {
    youtube: ['<svg viewBox="0 0 24 24" fill="currentColor" style="color:#FF0000;width:10px;height:10px"><path d="M23.5 6.2c-.3-1-1-1.8-2-2.1C19.6 3.5 12 3.5 12 3.5s-7.6 0-9.5.6c-1 .3-1.7 1.1-2 2.1C0 8.1 0 12 0 12s0 3.9.5 5.8c.3 1 1 1.8 2 2.1 1.9.6 9.5.6 9.5.6s7.6 0 9.5-.6c1-.3 1.7-1.1 2-2.1.5-1.9.5-5.8.5-5.8s0-3.9-.5-5.8zM9.5 15.5v-7l6.4 3.5-6.4 3.5z"/></svg>','YouTube'],
    'youtube-url': ['<svg viewBox="0 0 24 24" fill="currentColor" style="color:#FF0000;width:10px;height:10px"><path d="M23.5 6.2c-.3-1-1-1.8-2-2.1C19.6 3.5 12 3.5 12 3.5s-7.6 0-9.5.6c-1 .3-1.7 1.1-2 2.1C0 8.1 0 12 0 12s0 3.9.5 5.8c.3 1 1 1.8 2 2.1 1.9.6 9.5.6 9.5.6s7.6 0 9.5-.6c1-.3 1.7-1.1 2-2.1.5-1.9.5-5.8.5-5.8s0-3.9-.5-5.8zM9.5 15.5v-7l6.4 3.5-6.4 3.5z"/></svg>','YouTube'],
    vimeo: ['<svg viewBox="0 0 24 24" fill="currentColor" style="color:#1AB7EA;width:10px;height:10px"><path d="M23.977 6.416c-.105 2.338-1.739 5.543-4.894 9.609-3.268 4.247-6.026 6.37-8.29 6.37-1.409 0-2.578-1.294-3.553-3.881L5.322 11.4C4.603 8.816 3.834 7.522 3.01 7.522c-.179 0-.806.378-1.881 1.132L0 7.197c1.185-1.044 2.351-2.084 3.501-3.128C5.08 2.701 6.266 1.984 7.055 1.91c1.867-.18 3.016 1.1 3.447 3.838.465 2.953.789 4.789.971 5.507.539 2.45 1.131 3.674 1.776 3.674.502 0 1.256-.796 2.265-2.385 1.004-1.589 1.54-2.797 1.612-3.628.144-1.371-.395-2.061-1.614-2.061-.574 0-1.167.121-1.777.391 1.186-3.868 3.434-5.757 6.762-5.637 2.473.06 3.628 1.664 3.493 4.797z"/></svg>','Vimeo'],
    direct: ['<svg viewBox="0 0 24 24" fill="currentColor" style="color:#4ADE80;width:10px;height:10px"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>','Video'],
    hls: ['<svg viewBox="0 0 24 24" fill="currentColor" style="color:#4ADE80;width:10px;height:10px"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>','HLS Stream'],
    drive: ['<svg viewBox="0 0 24 24" fill="currentColor" style="color:#4285F4;width:10px;height:10px"><path d="M6.6 15L1 21h22l-5.6-6H6.6zM8.4 5L3 15h6l5.4-10H8.4zM15.6 5L21 15l-3.4-5.4L15.6 5z"/></svg>','Drive'],
    audio: ['<svg viewBox="0 0 24 24" fill="currentColor" style="color:#C7B8FF;width:10px;height:10px"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>','Audio'],
    spotify: ['<svg viewBox="0 0 24 24" fill="#1DB954" style="width:10px;height:10px"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>','Spotify'],
    soundcloud: ['<svg viewBox="0 0 24 24" fill="#FF5500" style="width:10px;height:10px"><path d="M1.175 12.225c-.051 0-.094.046-.101.1l-.233 2.154.233 2.105c.007.058.05.098.101.098.05 0 .09-.04.099-.098l.255-2.105-.27-2.154c-.009-.06-.049-.1-.084-.1zm22.284-4.346c-.111 0-.215.024-.312.064C22.677 5.14 20.393 3.5 17.714 3.5c-.707 0-1.387.142-2.005.393C15.162 3.012 13.71 2.5 12.143 2.5 8.58 2.5 5.7 5.38 5.7 8.943c0 .27.02.536.057.797C4.55 9.79 3.6 10.781 3.6 12c0 1.334 1.08 2.414 2.414 2.414h17.445c1.334 0 2.414-1.08 2.414-2.414 0-1.334-1.08-2.414-2.414-2.121z"/></svg>','SoundCloud'],
    website: ['<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:#FBBF24;width:10px;height:10px"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>','Website'],
  };

  const key = sourceType || (mode === 'browser' ? 'website' : 'direct');
  if (icons[key]) { icon.innerHTML = icons[key][0]; text.textContent = icons[key][1]; }
}

// ============================================================
// VIDEO PLAYER CREATION
// ============================================================

function loadYouTubeAPI() {
  return new Promise(resolve => {
    if (window.YT?.Player) { resolve(); return; }
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = resolve;
  });
}

function createBrowserIframe(url) {
  if (browserIframe) { browserIframe.remove(); browserIframe = null; }
  const iframe = document.createElement('iframe');
  iframe.id = 'browserFrame';
  // No sandbox — full browser context, same as how embed/OTT players run.
  // sandbox was preventing scripts, forms, popups, etc. from working on real sites.
  iframe.referrerPolicy = 'no-referrer-when-downgrade';
  iframe.allow = 'fullscreen *; autoplay *; encrypted-media *; picture-in-picture *; accelerometer *; gyroscope *; clipboard-write *; camera *; microphone *; geolocation *; web-share *; payment *; display-capture *';
  iframe.src = url;
  iframe.style.cssText = 'width:100%;height:100%;border:none;background:#fff;';
  iframe.loading = 'eager';
  browserIframe = iframe;
  return iframe;
}

// ── X-Frame-Options / CSP block detection ────────────────────
// Called after a browser iframe is created. If the host sends X-Frame-Options:DENY
// or CSP frame-ancestors:'none', the browser shows a blank/error page in the iframe.
// We can only detect this for same-origin error pages (blank contentDocument.body).
// Cross-origin pages that loaded correctly will throw a SecurityError — that's fine.
function _detectIframeBlock(iframe, url) {
  const check = () => {
    try {
      const doc = iframe.contentDocument;
      // If we can read contentDocument it means either:
      // (a) same-origin page loaded  →  fine
      // (b) browser replaced it with a blank about:blank error page  →  blocked
      if (doc && doc.readyState !== 'loading') {
        const bodyText = doc.body?.innerText?.trim() || '';
        const isEmpty = bodyText === '' && !doc.querySelector('video,iframe,img');
        if (isEmpty) _showBrowserBlockedOverlay(url);
      }
    } catch {
      // SecurityError = cross-origin page loaded successfully — do nothing
    }
  };
  iframe.addEventListener('load', () => { setTimeout(check, 600); });
  // Fallback: some browsers suppress load events for blocked frames
  setTimeout(check, 6000);
}

// Show an overlay when a site can't be embedded (X-Frame-Options / CSP)
function _showBrowserBlockedOverlay(url) {
  const vc = document.getElementById('videoContainer');
  if (!vc || vc.querySelector('#browserBlockedOverlay')) return;
  let hostname = url;
  try { hostname = new URL(url).hostname; } catch {}
  const overlay = document.createElement('div');
  overlay.id = 'browserBlockedOverlay';
  overlay.innerHTML = `
    <div class="browser-blocked-card">
      <div class="browser-blocked-icon">🚫</div>
      <h3>${escapeHtml(hostname)} can't be embedded</h3>
      <p>This site blocks external embedding (X-Frame-Options / CSP). It's a browser security rule — not something we can override without a server proxy.</p>
      <a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="browser-blocked-btn">Open in new tab ↗</a>
      <p class="browser-blocked-tip">For movies &amp; shows, paste an IMDb ID in 🎬 Stream Engine instead.</p>
    </div>`;
  vc.appendChild(overlay);
}

// ── Browser-mode video auto-expand ───────────────────────────
// Listen for postMessage events from embedded iframes that signal video playback.
// Many HTML5 players, YouTube, etc. broadcast play events via postMessage.
// When detected, auto-request fullscreen on the video container.
let _browserAutoExpanded = false;

function _onIframeMessage(e) {
  if (currentMode !== 'browser') return;
  if (_browserAutoExpanded) return;

  const d = e.data;
  if (!d) return;

  // Normalise: handle string JSON payloads
  let payload = d;
  if (typeof d === 'string') {
    try { payload = JSON.parse(d); } catch { payload = d; }
  }

  const isPlay = (
    payload === 'play' ||
    payload?.type === 'play'    || payload?.action === 'play'   ||
    payload?.event === 'play'   || payload?.state === 'playing' ||
    payload?.command === 'play' || payload?.name === 'playing'  ||
    payload?.data?.event === 'play' ||
    (typeof payload === 'string' && /("event"\s*:\s*"play"|"state"\s*:\s*"playing")/.test(payload))
  );

  if (isPlay) {
    _browserAutoExpanded = true;
    _expandVideoContainer();
  }
}

function _expandVideoContainer() {
  const vc = document.getElementById('videoContainer');
  if (!vc) return;
  const req = vc.requestFullscreen || vc.webkitRequestFullscreen || vc.mozRequestFullScreen;
  if (req) {
    req.call(vc).catch(() => {
      // Fullscreen requires a user gesture in some browsers — show a nudge instead
      showNotification('Video playing', 'info');
    });
  }
}

async function createVideoPlayer(url) {
  const rawType = detectVideoType(url);
  let processedUrl = url;
  let type = rawType;

  const videoContainer = document.getElementById('videoContainer');
  const placeholder = document.getElementById('videoPlaceholder');

  videoContainer.innerHTML = '';
  videoContainer.classList.remove('iframe-mode');
  if (placeholder) videoContainer.appendChild(placeholder);
  if (placeholder) placeholder.style.display = 'none';
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  videoPlayer = null;
  youtubePlayer = null;
  ytReady = false;
  // Reset language selector for new media
  availableAudioTracks = [];
  availableSubtitleTracks = [];
  currentAudioTrackId = -1;
  currentSubtitleTrackId = -1;
  // Preserve embed lang/subtitle preference — re-hydrate from localStorage so
  // the user's selections survive navigation and synced loads.
  currentEmbedLang    = localStorage.getItem('wotchly_embed_lang')     || 'hi';   // default Hindi dub
  currentEmbedSubLang = localStorage.getItem('wotchly_embed_sub_lang') || null;
  isEmbedLangMode = false;
  embedPlayStartTime = null;
  embedCurrentOffset = 0;
  stopEmbedTimeUpdater();
  _syncOverlayShown = false;
  hideSyncOverlay();
  updateSyncBadge('hidden');
  const langSelReset = document.getElementById('langSelector');
  if (langSelReset) langSelReset.style.display = 'none';
  clearDriveSubtitleOverlay();
  // iframeNotice element removed — no-op guard kept for safety
  const _iframeNotice = document.getElementById('iframeNotice');
  if (_iframeNotice) _iframeNotice.style.display = 'none';
  // Restore lang panel header text
  const _lph = document.querySelector('#langPanel .lang-panel-header span');
  if (_lph) _lph.textContent = 'Audio & Subtitles';
  const _lat = document.querySelector('#langAudioSection .lang-section-title');
  if (_lat) _lat.textContent = 'Audio Track';

  // Google Drive — embed iframe
  if (rawType === 'drive') {
    const fileMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    const idParam = (() => { try { return new URL(url).searchParams.get('id'); } catch { return null; } })();
    const fileId = fileMatch ? fileMatch[1] : idParam;
    if (fileId) {
      currentVideoType = 'drive';
      currentVideoUrl = url;
      const iframe = document.createElement('iframe');
      iframe.id = 'driveFrame';
      iframe.src = `https://drive.google.com/file/d/${fileId}/preview`;
      iframe.style.cssText = 'width:100%;height:100%;border:none;position:absolute;top:0;left:0;background:#000;';
      iframe.allow = 'autoplay; fullscreen; picture-in-picture';
      iframe.allowFullscreen = true;
      videoContainer.appendChild(iframe);
      videoContainer.classList.add('iframe-mode');
      startEmbedTimeUpdater();
      showNotification('Google Drive video loaded', 'success');
      updateModeIndicator('player', 'drive');
      setupDriveSubtitlePanel();
    } else {
      showNotification('Invalid Google Drive URL', 'error');
    }
    return;
  }

  currentVideoType = type;
  currentVideoUrl = url;

  // ---- YouTube ----
  if (type === 'youtube' || type === 'youtube-url') {
    const videoId = extractYouTubeId(url);
    if (!videoId) { showNotification('Invalid YouTube URL', 'error'); return; }
    await loadYouTubeAPI();
    const div = document.createElement('div');
    div.id = 'ytPlayer';
    div.style.cssText = 'width:100%;height:100%;position:absolute;top:0;left:0;';
    videoContainer.appendChild(div);
    youtubePlayer = new YT.Player('ytPlayer', {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: { autoplay: 0, controls: 1, modestbranding: 1, rel: 0, playsinline: 1, fs: 1, iv_load_policy: 3, cc_load_policy: 0 },
      events: {
        onReady: e => {
          ytReady = true;
          const seekSlider = document.getElementById('seekSlider');
          if (seekSlider) seekSlider.max = Math.floor(e.target.getDuration());
          applyAudioSettings();
          startYouTubeTimeUpdater();
          showNotification('YouTube video loaded', 'success');
          // Initial guest sync — seek to host's current position
          if (!isHost && pendingInitialSync) {
            const target = computeSyncTarget(pendingInitialSync);
            e.target.seekTo(target, true);
            if (pendingInitialSync.playState === 'playing') {
              isManuallyPaused = false;
              e.target.playVideo();
            }
            pendingInitialSync = null;
          }
        },
        onStateChange: e => {
          if (!ytReady) return;
          const t = e.target.getCurrentTime();
          if (e.data === YT.PlayerState.PLAYING) {
            lastKnownPlayingState = true;
            if (isHost) {
              updateFirebaseState('playing', t);
              updateMediaSessionPlaybackState('playing');
            }
          } else if (e.data === YT.PlayerState.PAUSED) {
            // ── Background auto-pause: YouTube paused itself when tab/app went
            //    hidden. Counter it immediately in the same event-loop tick so it
            //    never fully settles into a paused state.
            if (document.hidden && !userInitiatedPause && !isManuallyPaused && lastKnownPlayingState) {
              startSilentAudio();
              keepAudioContextAlive();
              // Synchronous attempt (highest chance of success)
              try { e.target.playVideo(); } catch {}
              // Belt-and-suspenders: retry after YouTube finishes its pause cycle
              setTimeout(() => {
                if (youtubePlayer && ytReady && document.hidden
                    && !userInitiatedPause && !isManuallyPaused && lastKnownPlayingState) {
                  try { youtubePlayer.playVideo(); } catch {}
                }
              }, 250);
              setTimeout(() => {
                if (youtubePlayer && ytReady && document.hidden
                    && !userInitiatedPause && !isManuallyPaused && lastKnownPlayingState) {
                  try { youtubePlayer.playVideo(); } catch {}
                }
              }, 800);
            } else if (isHost && userInitiatedPause) {
              // Intentional pause by the host — sync state to Firebase
              lastKnownPlayingState = false;
              updateFirebaseState('paused', t);
              updateMediaSessionPlaybackState('paused');
            }
          }
        },
        onError: () => showNotification('YouTube error', 'error')
      }
    });
    updateModeIndicator('player', 'youtube-url');
    return;
  }

  // ---- Vimeo ----
  if (type === 'vimeo') {
    const id = extractVimeoId(url);
    if (!id) { showNotification('Invalid Vimeo URL', 'error'); return; }
    const iframe = document.createElement('iframe');
    iframe.id = 'vimeoPlayer';
    iframe.src = `https://player.vimeo.com/video/${id}?autoplay=0&title=0&byline=0&portrait=0&color=C7B8FF`;
    iframe.style.cssText = 'width:100%;height:100%;border:none;position:absolute;top:0;left:0;';
    iframe.allow = 'autoplay; fullscreen; picture-in-picture';
    iframe.allowFullscreen = true;
    videoContainer.appendChild(iframe);
    videoContainer.classList.add('iframe-mode');
    showNotification('Vimeo video loaded', 'success');
    updateModeIndicator('player', 'vimeo');
    return;
  }

  // ---- Dailymotion ----
  if (type === 'dailymotion') {
    const id = extractDailymotionId(url);
    if (!id) { showNotification('Invalid Dailymotion URL', 'error'); return; }
    const iframe = document.createElement('iframe');
    iframe.id = 'dailymotionPlayer';
    iframe.src = `https://www.dailymotion.com/embed/video/${id}?autoplay=0`;
    iframe.style.cssText = 'width:100%;height:100%;border:none;position:absolute;top:0;left:0;';
    iframe.allow = 'autoplay; fullscreen';
    iframe.allowFullscreen = true;
    videoContainer.appendChild(iframe);
    videoContainer.classList.add('iframe-mode');
    showNotification('Dailymotion video loaded', 'success');
    updateModeIndicator('player', 'dailymotion');
    return;
  }

  // ---- Music streaming ----
  if (isMusicStreamingSite(url)) {
    const { embedUrl, embedType } = getMusicEmbedUrl(url);
    if (embedUrl && isAllowedEmbedHost(embedUrl)) {
      const wrapper = createMusicEmbedPlayer(embedUrl, embedType, url);
      if (wrapper) {
        videoContainer.appendChild(wrapper);
        showNotification(`${embedType} loaded`, 'success');
        updateModeIndicator('player', embedType);
        return;
      }
    }
  }

  // ---- HLS / m3u8 ----
  if (type === 'hls') {
    const video = createBaseVideoElement();
    videoContainer.appendChild(video);
    videoPlayer = video;

    if (Hls.isSupported()) {
      hlsInstance = new Hls({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 30, maxBufferSize: 60 * 1000 * 1000 });
      hlsInstance.loadSource(processedUrl);
      hlsInstance.attachMedia(video);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        showNotification('HLS stream loaded', 'success');
        const seekSlider = document.getElementById('seekSlider');
        if (seekSlider && video.duration) seekSlider.max = Math.floor(video.duration);
        applyAudioSettings();
        connectMediaToAudioContext(video);
        initMediaSession();
        // Detect audio + subtitle tracks
        _detectHlsTracks();
      });
      hlsInstance.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => { _detectHlsTracks(); });
      hlsInstance.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => { _detectHlsTracks(); });
      hlsInstance.on(Hls.Events.ERROR, (e, data) => {
        if (!data.fatal) return;
        console.warn('[HLS] Fatal error:', data.type, data.details);
        hlsInstance.destroy();
        hlsInstance = null;

        // On fatal error, try a reliable MP4 fallback so the player never stays blank.
        // Pick a different clip than the primary fallback to increase variety.
        const FATAL_FALLBACK_STREAMS = [
          'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
          'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
          'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
        ];
        const fallbackMp4 = FATAL_FALLBACK_STREAMS[Math.floor(Math.random() * FATAL_FALLBACK_STREAMS.length)];

        showNotification('Stream unavailable — loading demo clip', 'info');
        // Set src directly (MP4, no hls.js needed) so video.error won't fire
        video.src = fallbackMp4;
        video.load();
        video.play().catch(() => {});
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = processedUrl;
      showNotification('HLS stream loaded (native)', 'success');
    } else {
      showNotification('HLS not supported in this browser', 'error');
    }
    updateModeIndicator('player', 'hls');
    return;
  }

  // ---- Embed providers (autoembed, vidlink, etc.) ----
  if (type === 'embed') {
    // If the incoming URL already has lang/sub params (e.g. from Firebase sync),
    // honour them so UI stays in sync; otherwise fall back to saved preferences.
    const incomingParams = _parseEmbedParamsFromUrl(url);
    if (incomingParams.audio) { currentEmbedLang    = incomingParams.audio; localStorage.setItem('wotchly_embed_lang',     incomingParams.audio); }
    if (incomingParams.sub)   { currentEmbedSubLang = incomingParams.sub;   localStorage.setItem('wotchly_embed_sub_lang', incomingParams.sub);   }
    // Apply audio + subtitle params at load time
    const embedSrc = (currentEmbedLang || currentEmbedSubLang)
      ? _applyEmbedParams(url, currentEmbedLang, currentEmbedSubLang) : url;
    const iframe = document.createElement('iframe');
    iframe.id = 'embedFrame';
    iframe.src = embedSrc;
    iframe.style.cssText = 'width:100%;height:100%;border:none;position:absolute;top:0;left:0;background:#000;';
    iframe.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media';
    iframe.allowFullscreen = true;
    // Block popups/tab-opens from ads without breaking the player itself.
    // allow-popups and allow-top-navigation are intentionally omitted.
    videoContainer.appendChild(iframe);
    videoContainer.classList.add('iframe-mode');
    currentVideoType = 'embed';
    currentVideoUrl = embedSrc;
    currentMode = 'player';
    // Guests: apply pendingInitialSync once the embed player has had time to
    // initialise — mirrors the loadedmetadata / YouTube onReady handlers so
    // late-joining guests always seek to the host's current position after a
    // URL change (including audio/subtitle reloads).
    if (!isHost) {
      iframe.addEventListener('load', () => {
        setTimeout(() => {
          if (!pendingInitialSync) return;
          const target = computeSyncTarget(pendingInitialSync);
          // Force-seek on initial load — bypass the normal drift threshold so
          // a guest starting at offset 0 is always corrected to the host's position.
          sendIframeCommand('seek', target);
          embedCurrentOffset = target;
          if (pendingInitialSync.playState === 'playing') {
            isManuallyPaused = false;
            sendIframeCommand('play');
            embedPlayStartTime = Date.now();
          }
          pendingInitialSync = null;
        }, 1500);
      });
    }
    startEmbedTimeUpdater();
    showNotification('Stream loading — please wait…', 'info');
    updateModeIndicator('player', 'embed');
    populateEmbedLangSelector();
    return;
  }

  // ---- Crunchyroll — DRM-protected, iframe blocked ----
  if (type === 'website' && url.includes('crunchyroll.com')) {
    // Try to extract show title from URL path: /watch/XXXX/show-title-here
    let animeName = '';
    try {
      const pathParts = new URL(url).pathname.split('/').filter(Boolean);
      // Crunchyroll URLs: /watch/<id>/<slug>  or  /series/<id>/<slug>
      const slugIdx = pathParts.findIndex(p => p === 'watch' || p === 'series');
      if (slugIdx !== -1 && pathParts[slugIdx + 2]) {
        animeName = pathParts[slugIdx + 2].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      } else if (slugIdx !== -1 && pathParts[slugIdx + 1]) {
        animeName = pathParts[slugIdx + 1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      }
    } catch { /* ignore */ }

    // Pre-fill the Stream Engine anime search and open it
    const seAnimeQuery = document.getElementById('seAnimeQuery');
    const videoModal = document.getElementById('videoModal');
    const seAnimePanelTab = document.querySelector('.se-tab[data-se-tab="seAnimePanel"]');
    const seAnimePanel = document.getElementById('seAnimePanel');
    const seImdbPanel = document.getElementById('seImdbPanel');

    if (animeName && seAnimeQuery) seAnimeQuery.value = animeName;
    if (videoModal) videoModal.classList.add('active');
    // Switch to Anime tab
    document.querySelectorAll('.se-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.se-panel').forEach(p => (p.style.display = 'none'));
    if (seAnimePanelTab) seAnimePanelTab.classList.add('active');
    if (seAnimePanel) seAnimePanel.style.display = 'block';

    showNotification(
      animeName
        ? `Crunchyroll uses DRM — searching "${animeName}" in Anime tab`
        : 'Crunchyroll uses DRM — use the Anime tab to search',
      'error'
    );

    // Show a placeholder so the video area is not blank
    const videoContainer = document.getElementById('videoContainer');
    const placeholder = document.getElementById('videoPlaceholder');
    if (videoContainer) {
      videoContainer.innerHTML = '';
      if (placeholder) { videoContainer.appendChild(placeholder); placeholder.style.display = 'flex'; }
    }
    return;
  }

  // ---- Website / Browser iframe ----
  if (type === 'website') {
    const OTT = ['netflix.com','primevideo.com','amazon.com/primevideo','jiohotstar.com','hotstar.com','disneyplus.com','disney.com/disneyplus'];
    const isOTT = OTT.some(d => url.includes(d));
    if (isOTT) {
      // Use whichever provider is currently selected in the Stream Engine UI
      const selectedBase = _getSelectedProviderBase();
      const resolved = resolveOttEmbed(url, 'movie', null, null, selectedBase);
      if (resolved) {
        // Sync any params already baked into resolved URL; then apply saved preferences
        const incomingOtt = _parseEmbedParamsFromUrl(resolved.url);
        if (incomingOtt.audio) { currentEmbedLang    = incomingOtt.audio; localStorage.setItem('wotchly_embed_lang',     incomingOtt.audio); }
        if (incomingOtt.sub)   { currentEmbedSubLang = incomingOtt.sub;   localStorage.setItem('wotchly_embed_sub_lang', incomingOtt.sub);   }
        const ottSrc = (currentEmbedLang || currentEmbedSubLang)
          ? _applyEmbedParams(resolved.url, currentEmbedLang, currentEmbedSubLang) : resolved.url;
        currentVideoType = 'embed';
        currentVideoUrl = ottSrc;
        const iframe = document.createElement('iframe');
        iframe.id = 'ottEmbedFrame';
        iframe.src = ottSrc;
        iframe.style.cssText = 'width:100%;height:100%;border:none;position:absolute;top:0;left:0;background:#000;';
        iframe.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media';
        iframe.allowFullscreen = true;
        videoContainer.appendChild(iframe);
        videoContainer.classList.add('iframe-mode');
        // Guests: apply pendingInitialSync after the embed player initialises.
        if (!isHost) {
          iframe.addEventListener('load', () => {
            setTimeout(() => {
              if (!pendingInitialSync) return;
              const target = computeSyncTarget(pendingInitialSync);
              sendIframeCommand('seek', target);
              embedCurrentOffset = target;
              if (pendingInitialSync.playState === 'playing') {
                isManuallyPaused = false;
                sendIframeCommand('play');
                embedPlayStartTime = Date.now();
              }
              pendingInitialSync = null;
            }, 1500);
          });
        }
        startEmbedTimeUpdater();
        showNotification(`Stream loading via ${resolved.provider} — for TV series use Stream Engine`, 'info');
        updateModeIndicator('player', 'embed');
        populateEmbedLangSelector();
      } else {
        // Fallback: show placeholder with hint
        videoContainer.innerHTML = `
          <div class="browser-placeholder">
            <div class="browser-placeholder-icon">&#127916;</div>
            <h3>Use Stream Engine</h3>
            <p>Paste the IMDb ID or use the Stream Embed section below to load this title.</p>
            <p class="ott-url">${escapeHtml(url)}</p>
          </div>`;
        showNotification('Use the Stream Engine to load OTT titles', 'info');
        updateModeIndicator('browser', 'website');
        currentMode = 'browser';
      }
      return;
    } else {
      const wrapper = document.createElement('div');
      wrapper.className = 'browser-iframe-wrapper';
      const iframe = createBrowserIframe(url);
      wrapper.appendChild(iframe);
      videoContainer.appendChild(wrapper);

      // Reset auto-expand state for this new page
      _browserAutoExpanded = false;

      // Detect X-Frame-Options / CSP blocks gracefully
      _detectIframeBlock(iframe, url);

    }
    showNotification('Website loaded', 'success');
    updateModeIndicator('browser', 'website');
    currentMode = 'browser';
    return;
  }

  // ---- Direct video (MP4, WebM, etc.) ----
  const video = createBaseVideoElement();
  videoContainer.appendChild(video);
  videoPlayer = video;
  video.src = processedUrl;
  video.load();
  updateModeIndicator('player', type === 'drive' ? 'drive' : 'direct');
}

function createBaseVideoElement() {
  const video = document.createElement('video');
  video.id = 'videoPlayer';
  video.controls = false;
  video.playsInline = true;
  // Older iOS WebKit requires the lowercase DOM attribute form as well
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  // crossOrigin = 'anonymous' is intentionally NOT set here.
  // Setting it on streams from CDNs that lack CORS headers causes an immediate
  // MediaError on the video element ("Video failed to load").
  // WebAudio (connectMediaToAudioContext) sets it lazily only when EQ is needed,
  // and already has its own try/catch for the SecurityError.
  video.muted = isVideoMuted;
  video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;position:absolute;top:0;left:0;';

  const seekSlider = document.getElementById('seekSlider');

  video.addEventListener('loadedmetadata', () => {
    if (seekSlider) seekSlider.max = Math.floor(video.duration);
    updateTimeDisplay();
    showNotification('Video ready', 'success');
    applyAudioSettings();
    connectMediaToAudioContext(video);
    initMediaSession();
    // Initial guest sync — apply the snapshot captured at join time now
    // that the player has metadata and currentTime is seekable.
    if (!isHost && pendingInitialSync) {
      const target = computeSyncTarget(pendingInitialSync);
      video.currentTime = Math.min(target, video.duration || Infinity);
      if (pendingInitialSync.playState === 'playing') {
        isManuallyPaused = false;
        video.play().catch(() => {});
      }
      pendingInitialSync = null;
    }
    // Detect native HTML5 audio tracks (supported in Safari / some browsers)
    if (video.audioTracks && video.audioTracks.length > 1) {
      const tracks = [];
      for (let i = 0; i < video.audioTracks.length; i++) {
        tracks.push({
          id: i,
          name: video.audioTracks[i].label || formatLangName(video.audioTracks[i].language) || `Track ${i + 1}`,
          lang: video.audioTracks[i].language || '',
          default: video.audioTracks[i].enabled
        });
      }
      currentAudioTrackId = tracks.findIndex(t => t.default);
      if (currentAudioTrackId < 0) currentAudioTrackId = 0;
      populateLangSelector(tracks, []);
    } else {
      const langSelEl = document.getElementById('langSelector');
      if (langSelEl) langSelEl.style.display = 'none';
    }
  });
  video.addEventListener('timeupdate', () => {
    if (!isSeeking) {
      if (seekSlider) seekSlider.value = Math.floor(video.currentTime);
      updateTimeDisplay();
    }
    lastKnownCurrentTime = video.currentTime;
  });
  video.addEventListener('ended', () => {
    if (isHost) updateFirebaseState('paused', 0);
  });
  video.addEventListener('error', () => {
    // Suppress when hls.js is active — it manages its own error reporting.
    // This fires spuriously when hls.js tears down its MediaSource on a fatal error,
    // which would otherwise show a second "failed to load" toast on top of the hls one.
    if (hlsInstance) return;
    showNotification('Video failed to load. Check the URL.', 'error');
  });
  video.addEventListener('play', () => {
    lastKnownPlayingState = true;
    updateMediaSessionPlaybackState('playing');
    stopSilentAudio(); // video has audio — silent keepalive no longer needed
  });

  // iOS Safari fires these when the video enters/exits the native fullscreen
  // player (which happens automatically on screen lock while playing).
  // On exit (e.g. user unlocked the screen), we must force-resume playback
  // because iOS pauses the video when it leaves native fullscreen.
  video.addEventListener('webkitbeginfullscreen', () => {
    lastKnownPlayingState = !video.paused;
  });
  video.addEventListener('webkitendfullscreen', () => {
    if (lastKnownPlayingState && !isManuallyPaused && !userInitiatedPause) {
      setTimeout(() => {
        video.play().catch(() => {
          video.muted = true;
          video.play().catch(() => {}).then(() => {
            setTimeout(() => { video.muted = isVideoMuted; }, 300);
          });
        });
      }, 100);
    }
  });
  video.addEventListener('pause', () => {
    if (!userInitiatedPause) {
      // System pause (tab/app switch) — do NOT tell MediaSession we are paused.
      // Reporting 'paused' here tells Chrome to stop background audio and remove
      // the media notification, making resumption impossible in the background.
      if (systemPauseResumeTimer) clearTimeout(systemPauseResumeTimer);
      systemPauseResumeTimer = setTimeout(() => {
        // Resume even when hidden — browsers pause video on tab/app switch
        if (video?.paused && !userInitiatedPause) {
          keepAudioContextAlive();
          startSilentAudio(); // keep Chrome's audio session alive
          video.play().catch(() => {
            // Muted-play fallback, then unmute after resume
            const prevMuted = video.muted;
            video.muted = true;
            video.play().catch(() => {}).then(() => {
              setTimeout(() => { video.muted = prevMuted; }, 300);
            });
          });
        }
      }, SYSTEM_PAUSE_RESUME_DELAY);
    } else {
      // User explicitly paused — update media session so notification shows pause
      updateMediaSessionPlaybackState('paused');
      stopSilentAudio();
    }
  });

  return video;
}

async function loadSharedContent(url) {
  if (!url) return;
  await createVideoPlayer(url);
}

// ============================================================
// MOVIEBOX DISCOVERY
// ============================================================

// Public Render API base URL. Render builds need to call this directly;
// Netlify deployments can still fall back to the server-side function when it
// is not configured. Never assume the hosting platform from import.meta.env.DEV.
const RENDER_API_BASE = (() => {
  const raw = ((typeof import.meta !== 'undefined' && (import.meta.env?.VITE_MOVIEBOX_API_URL || import.meta.env?.MOVIEBOX_API_URL)) || 'https://moviebox-internal-api.onrender.com').trim();
  if (!raw) return '';
  return `${/^https?:\/\//i.test(raw) ? '' : 'https://'}${raw}`.replace(/\/$/, '');
})();


// Gradient palette for dynamically-rendered cards that have no cover image.
const _MB_GRADIENTS = [
  'linear-gradient(160deg,#1a0533 0%,#3d0f6e 55%,#7c1fa3 100%)',
  'linear-gradient(160deg,#0d1b2a 0%,#1b3a5c 55%,#2e6da4 100%)',
  'linear-gradient(160deg,#1a0011 0%,#4d0033 55%,#990055 100%)',
  'linear-gradient(160deg,#0a1a0a 0%,#1a4020 55%,#2a6e35 100%)',
  'linear-gradient(160deg,#1a1000 0%,#4d3000 55%,#8c5a00 100%)',
  'linear-gradient(160deg,#00101a 0%,#00304d 55%,#005c8c 100%)',
];

/**
 * Build card HTML for a list of movie/show items and inject into the grid.
 * Re-attaches click handlers so host selections work on live results.
 * @param {Array<{id,title,year,lang,rating,cover,cat,gradient}>} items
 * @param {HTMLElement} grid   – .mb-ranks-grid element
 * @param {HTMLElement} [hero] – .mb-hero element; updated if items.length > 0
 */
function renderMovieBoxCards(items, grid, hero) {
  if (!grid) return;

  if (!items.length) {
    grid.innerHTML = '<p style="color:var(--text-muted);padding:1rem;grid-column:1/-1;text-align:center">No results found</p>';
    return;
  }

  grid.innerHTML = items.map((item, i) => {
    const bg = item.gradient || _MB_GRADIENTS[i % _MB_GRADIENTS.length];
    const coverImg = item.cover
      ? `<img src="${item.cover}" alt="${item.title}" class="mb-poster-img" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.85">`
      : '';
    const lang  = item.lang || item.language || '';
    const year  = item.year  || '';
    const stars = item.rating ? `${item.rating} ★` : '';
    const meta  = [year, stars].filter(Boolean).join(' &nbsp;·&nbsp; ');
    return `
      <div class="mb-rank-item" data-cat="${item.cat || 'all'}">
        <div class="mb-card" data-movie-id="${item.id}" data-title="${item.title}" title="Click to play in room">
          <div class="mb-poster" style="background:${bg};position:relative;overflow:hidden">
            ${coverImg}
            <span class="mb-rank-badge">${i + 1}</span>
            ${lang ? `<span class="mb-lang-badge">${lang}</span>` : ''}
            <div class="mb-poster-play">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><polygon points="6,3 20,12 6,21"/></svg>
            </div>
            <div class="mb-poster-overlay"></div>
          </div>
          <div class="mb-card-info">
            <p class="mb-card-title">${item.title}</p>
            ${meta ? `<p class="mb-card-meta">${meta}</p>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  // Re-attach click handlers
  grid.querySelectorAll('.mb-card[data-movie-id]').forEach(card => {
    card.addEventListener('click', () => {
      if (!isHost) { showNotification('Only the host can select media', 'info'); return; }
      selectMovieBoxTitle(card.dataset.movieId);
    });
  });

  // Update hero banner to show the first result
  if (hero && items.length > 0) {
    const first = items[0];
    const bg = first.gradient || _MB_GRADIENTS[0];
    hero.dataset.movieId  = first.id;
    hero.dataset.title    = first.title;
    const heroBg = hero.querySelector('.mb-hero-bg');
    if (heroBg) {
      heroBg.style.background = bg;
      // Swap in a cover image if available
      let img = heroBg.querySelector('.mb-hero-cover-img');
      if (first.cover) {
        if (!img) {
          img = document.createElement('img');
          img.className = 'mb-hero-cover-img';
          img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.7';
          heroBg.prepend(img);
        }
        img.src = first.cover;
        img.alt = first.title;
      } else if (img) {
        img.remove();
      }
    }
    const titleEl = hero.querySelector('.mb-hero-title');
    if (titleEl) { titleEl.textContent = first.title; titleEl.style.opacity = ''; }
    const metaEl = hero.querySelector('.mb-hero-meta');
    if (metaEl) {
      const parts = [first.year, first.lang || first.language, first.type].filter(Boolean);
      metaEl.innerHTML = parts.join(' &nbsp;·&nbsp; ');
      metaEl.style.opacity = '';
    }
    const eyebrow = hero.querySelector('.mb-hero-eyebrow');
    if (eyebrow) {
      eyebrow.style.opacity = '';
      const dot = eyebrow.querySelector('.mb-live-dot');
      eyebrow.innerHTML = '';
      if (dot) eyebrow.appendChild(dot);
      eyebrow.appendChild(document.createTextNode(' Trending Now'));
    }
    const actions = hero.querySelector('.mb-hero-actions');
    if (actions) actions.style.opacity = '';
  }
}

// Language-code → category mapping for client-side sub-tab filtering.
// Used when the API doesn't return an explicit category/genre field.
const _MB_LANG_CAT = {
  hi: 'bollywood', hin: 'bollywood', hindi: 'bollywood',
  en: 'hollywood', eng: 'hollywood', english: 'hollywood',
  ko: 'korean',    kor: 'korean',
  ja: 'anime',     jpn: 'anime',
  ta: 'south',     tel: 'south',    ml: 'south', kn: 'south',
  zh: 'chinese',   cmn: 'chinese',
};

/** Infer display category from an API item for client-side sub-tab filtering. */
function _inferCat(item) {
  const explicit = item.category || item.genre_key || item.genre_type;
  if (explicit) return String(explicit).toLowerCase();
  const lang = (item.lang || item.language || item.original_language || '').toLowerCase();
  return _MB_LANG_CAT[lang] || 'all';
}

/**
 * Fetch search results or a category feed.
 * Returns { items, errorType, status } — never throws.
 *
 * errorType values:
 *   null            – success
 *   'not_configured'– Netlify function returned 503 (MOVIEBOX_API_URL not set)
 *   'server_down'   – upstream API returned a non-OK status (5xx)
 *   'timeout'       – request timed out (Render cold-start likely)
 *   'network'       – failed to reach the Netlify function at all
 *   'unknown'       – anything else
 */
async function fetchMovieBoxFeed(category = 'trending', query = '') {
  const routeMap = {
    trending: 'trending', movie: 'movies', movies: 'movies', tv: 'tv',
    anime: 'anime', midnight: 'midnight', 'short drama': 'short-drama',
    serials: 'serials', bollywood: 'bollywood', hindi: 'hindi',
    south: 'south', korean: 'korean', web: 'web-series', drama: 'drama',
  };
  const route = routeMap[String(category).toLowerCase()] || String(category).toLowerCase();
  const directUrl = query
    ? `${RENDER_API_BASE}/search?q=${encodeURIComponent(query)}`
    : `${RENDER_API_BASE}/${route}`;
  const proxyUrl = query
    ? `/.netlify/functions/get-feed?q=${encodeURIComponent(query)}`
    : `/.netlify/functions/get-feed?category=${encodeURIComponent(category)}`;
  // Use the same-origin Netlify function first. Direct browser calls to Render
  // are not CORS-safe on the production Netlify deployment. The direct URL is
  // retained only as a fallback for the static/non-Netlify deployment.
  const urls = [proxyUrl, directUrl];
  let url = urls[0];

  let resp;
  let lastError;
  for (const candidateUrl of urls) {
    url = candidateUrl;
    try {
      resp = await fetch(candidateUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(28000),
      });
      if (resp.ok) break;
      lastError = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastError = err;
    }
  }
  if (!resp?.ok) {
    const errorType = (lastError?.name === 'TimeoutError' || lastError?.name === 'AbortError') ? 'timeout' : 'network';
    console.warn(`[MovieBox] Fetch failed (${errorType}):`, lastError?.message);
    return { items: null, errorType, status: resp?.status || null };
  }

  let json;
  try { json = await resp.json(); } catch {
    return { items: null, errorType: 'unknown', status: resp.status };
  }

  // Render adapters and the official BFF use several nested envelopes. Walk
  // the response and flatten section objects such as { list: [{ items: [] }] }.
  function collect(value, depth = 0) {
    if (!value || depth > 6) return [];
    if (Array.isArray(value)) {
      return value.flatMap(entry => {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const nested = entry.items || entry.list || entry.results || entry.content;
          return Array.isArray(nested) ? collect(nested, depth + 1) : [entry];
        }
        return [entry];
      });
    }
    if (typeof value === 'object') {
      for (const key of ['results', 'items', 'list', 'movies', 'shows', 'content', 'response', 'data']) {
        if (value[key] !== undefined) {
          const found = collect(value[key], depth + 1);
          if (found.length) return found;
        }
      }
    }
    return [];
  }
  let raw = collect(json);
  if (!raw) {
    // Unknown upstream response shape; surface it as a real API failure.
    console.warn('[MovieBox] Unexpected response shape from server:', JSON.stringify(json).slice(0, 150));
    return { items: [], errorType: 'unknown', status: resp.status };
  }

  const items = raw.map(item => ({
    id:       item.subjectId || item.subject_id || item.id || item.slug || String(item._id || ''),
    title:    item.title || item.name || '',
    year:     item.year  || item.release_year || item.releaseTime || '',
    lang:     item.lang  || item.language     || item.original_language || '',
    rating:   item.rating ?? item.score ?? item.vote_average ?? '',
    cover:    item.cover || item.thumbnail || item.image || item.poster || item.img
                ? (item.cover || item.thumbnail || item.image || item.poster || item.img)
                : item.poster_path
                  ? `https://image.tmdb.org/t/p/w300${item.poster_path}`
                  : item.backdrop_path
                    ? `https://image.tmdb.org/t/p/w300${item.backdrop_path}`
                    : '',
    type:     item.type  || item.media_type || (item.subjectType === 1 ? 'movie' : item.subjectType === 2 ? 'tv' : ''),
    cat:      _inferCat(item),
    gradient: item.gradient || '',
  })).filter(item => {
    if (!item.id || !item.title) return false;
    // Drop music/song items — they can't be streamed as video
    const t = (item.type || '').toLowerCase();
    return !['music', 'song', 'audio', 'mv', 'music_video', 'musicvideo'].includes(t);
  });

  return { items, errorType: null, status: 200 };
}

async function loadMovieBoxStream(movieId) {
  const directUrl = `${RENDER_API_BASE}/stream/${encodeURIComponent(movieId)}`;
  const proxyUrl = `/.netlify/functions/get-stream?id=${encodeURIComponent(movieId)}`;
  let resp = null;
  for (const candidateUrl of [proxyUrl, directUrl]) {
    try {
      resp = await fetch(candidateUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(28000),
      });
      if (resp.ok) break;
    } catch {
      resp = null;
    }
  }
  if (!resp || !resp.ok) {
    showNotification('MovieBox: server unreachable', 'error');
    return null;
  }

  if (!resp.ok) {
    showNotification(`MovieBox: server error (${resp.status})`, 'error');
    return null;
  }

  const data = await resp.json().catch(() => null);
  const streamUrl = data?.stream_url || data?.url;
  if (!streamUrl) {
    showNotification('MovieBox: response did not contain a stream URL', 'error');
    return null;
  }

  return streamUrl;
}

/**
 * Host: push a MovieBox title selection to Firebase.
 * Stores only the ID — each client fetches their own stream URL independently,
 * so the actual streaming link never travels through Firebase (IP-lock safe).
 */
async function selectMovieBoxTitle(movieId) {
  if (!isHost) { showNotification('Only the host can select media', 'info'); return; }

  document.getElementById('videoModal')?.classList.remove('active');
  showNotification('Loading from MovieBox…', 'info');

  // Write only the ID — each client fetches their own stream URL independently
  // via listenToRoom so the actual streaming link never travels through Firebase
  // (avoids IP-lock issues where a URL fetched by the host won't work for others).
  try {
    await update(ref(db, `rooms/${roomId}`), {
      currentMovieId: movieId,
      videoUrl: null,
      currentTime: 0,
      playState: 'paused',
      lastUpdatedBy: userId,
      lastUpdatedAt: Date.now(),
    });
  } catch {
    showNotification('Failed to sync selection', 'error');
  }
}

// SVG icons used in error cards (no emojis)
const _MB_SVG = {
  gear:    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="28" height="28"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  clock:   `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="28" height="28"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  wifi:    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="28" height="28"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>`,
  server:  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="28" height="28"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>`,
  alert:   `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="28" height="28"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
};

/**
 * Render a styled error message into a row element (SVG icons, no emojis).
 */
function _mbShowRowError(el, type, onRetry) {
  if (!el) return;
  const cfg = {
    not_configured: { icon: _MB_SVG.gear,   title: 'API not configured',      msg: 'Add <code style="background:rgba(255,255,255,.1);padding:1px 5px;border-radius:3px">MOVIEBOX_API_URL</code> to Netlify environment variables.', retryLabel: null },
    timeout:        { icon: _MB_SVG.clock,  title: 'Server is starting up',   msg: 'The API server is waking from inactivity. This takes ~30s.', retryLabel: 'Retry' },
    server_down:    { icon: _MB_SVG.server, title: 'API unavailable',         msg: 'The MovieBox server returned an error. Try again shortly.', retryLabel: 'Retry' },
    network:        { icon: _MB_SVG.wifi,   title: 'Connection error',        msg: 'Could not reach the server. Check your connection.', retryLabel: 'Retry' },
    unknown:        { icon: _MB_SVG.alert,  title: 'Unable to load content',  msg: 'Something went wrong. Please retry.', retryLabel: 'Retry' },
  };
  const { icon, title, msg, retryLabel } = cfg[type] || cfg.unknown;
  const btnId = 'mbErr_' + Date.now();
  el.innerHTML = `
    <div style="padding:1.5rem;text-align:center;display:flex;flex-direction:column;align-items:center;gap:.6rem;min-width:200px;width:100%">
      <div style="color:rgba(255,255,255,.35)">${icon}</div>
      <p style="font-weight:700;font-size:.8rem;color:var(--text,#f0f0f8);margin:0">${title}</p>
      <p style="color:rgba(255,255,255,.4);font-size:.72rem;line-height:1.5;max-width:260px;margin:0">${msg}</p>
      ${retryLabel ? `<button id="${btnId}" class="mb-retry-btn">${retryLabel}</button>` : ''}
    </div>`;
  if (retryLabel) document.getElementById(btnId)?.addEventListener('click', onRetry);
}

/**
 * Show a waking-up countdown then auto-retry.
 */
function _mbWakeCountdown(el, attempt, total, retryFn) {
  if (!el) return;
  let secs = 5;
  const cId = 'mbWC_' + Date.now(), rId = 'mbWR_' + Date.now();
  el.innerHTML = `
    <div style="padding:1.5rem;text-align:center;display:flex;flex-direction:column;align-items:center;gap:.6rem;width:100%">
      <div style="color:rgba(255,255,255,.35)">${_MB_SVG.clock}</div>
      <p style="font-weight:700;font-size:.8rem;color:var(--text,#f0f0f8);margin:0">Server is waking up…</p>
      <p style="color:rgba(255,255,255,.4);font-size:.72rem;line-height:1.5;max-width:260px;margin:0">
        Retrying in <strong id="${cId}">${secs}s</strong> &nbsp;(${attempt}/${total})
      </p>
      <button id="${rId}" class="mb-retry-btn">Retry Now</button>
    </div>`;
  const cEl = document.getElementById(cId);
  document.getElementById(rId)?.addEventListener('click', () => { clearInterval(t); retryFn(); });
  const t = setInterval(() => { secs--; if (cEl) cEl.textContent = `${secs}s`; if (secs <= 0) { clearInterval(t); retryFn(); } }, 1000);
}

/**
 * Initialise the MovieBox discovery panel.
 *
 * Layout (mirrors the MovieBox app):
 *  ┌─ search bar ─────────────────────────────────────┐
 *  │ [Trending] [Movie] [TV] [Anime] ... pills         │
 *  │ ┌── hero banner (large poster image) ──────────┐ │
 *  │ └──────────────────────────────────────────────┘ │
 *  │ ← featured / related horizontal scroll →         │
 *  │ Categories: [All] [Bollywood] [Hollywood] …      │
 *  │ Rankings  ← [Trending now][Cinema][Bollywood]... │
 *  │ ← rankings horizontal scroll (with rank badges) →│
 *  │ Cinema  ← horizontal scroll →                    │
 *  └──────────────────────────────────────────────────┘
 *
 * Search mode hides hero + home sections; shows results grid.
 */
function initMovieBoxUI() {
  const hero         = document.getElementById('mbHero');
  const heroBg       = document.getElementById('mbHeroBg');
  const heroContent  = document.getElementById('mbHeroContent');
  const heroTitle    = document.getElementById('mbHeroTitle');
  const heroMeta     = document.getElementById('mbHeroMeta');
  const heroSk       = document.getElementById('mbHeroSk');
  const featuredRow  = document.getElementById('mbFeaturedRow');
  const rankingsRow  = document.getElementById('mbRankingsRow');
  const cinemaRow    = document.getElementById('mbCinemaRow');
  const homeSections = document.getElementById('mbHomeSections');
  const searchResults= document.getElementById('mbSearchResults');
  const resultsGrid  = document.getElementById('mbResultsGrid');

  let _activePill    = 'trending';
  let _activeRankCat = 'all';
  let _trendingItems = [];   // cached for rankings sub-filter
  let _feedVersion   = 0;
  let _searchTimer;
  const MAX_RETRIES  = 5;

  // Silent wake-ping so Render server is warm before real requests arrive.
  // Also called immediately on init so the server starts waking on page load.
  function _wakePing() {
    fetch('/.netlify/functions/get-feed?category=trending', { signal: AbortSignal.timeout(30000) })
      .catch(() => {/* ignore — just warming the server */});
  }
  _wakePing(); // fire immediately on page load to pre-warm Render

  // ── Skeleton helpers ────────────────────────────────────────
  function _skRow(el, n = 5) {
    if (!el) return;
    el.innerHTML = Array.from({ length: n }, () =>
      `<div class="mb-card-sm mb-sk-card"><div class="mb-poster-sm mb-sk-poster"></div><div class="mb-sk-line-sm"></div></div>`
    ).join('');
  }

  // ── Render a single small card ──────────────────────────────
  function _cardHtml(item, i, showRank) {
    const bg   = item.gradient || _MB_GRADIENTS[i % _MB_GRADIENTS.length];
    const img  = item.cover ? `<img src="${item.cover}" class="mb-poster-img-abs" loading="lazy" alt="">` : '';
    const lang = item.lang || '';
    const rank = showRank ? `<span class="mb-rank-badge mb-rank-color-${Math.min(i + 1, 3)}">${i + 1}</span>` : '';
    const lb   = lang ? `<span class="mb-lang-badge">${lang}</span>` : '';
    const meta = [item.year, item.rating ? `${item.rating}★` : ''].filter(Boolean).join(' · ');
    const safeTitle = item.title.replace(/"/g, '&quot;');
    return `
      <div class="mb-card-sm" data-movie-id="${item.id}" data-title="${safeTitle}" title="${safeTitle}">
        <div class="mb-poster-sm" style="background:${bg}">
          ${img}${rank}${lb}
          <div class="mb-poster-play-sm">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><polygon points="6,3 20,12 6,21"/></svg>
          </div>
          <div class="mb-poster-overlay"></div>
        </div>
        <p class="mb-card-title">${item.title}</p>
        ${meta ? `<p class="mb-card-meta">${meta}</p>` : ''}
      </div>`;
  }

  // ── Render a horizontal scroll row ─────────────────────────
  function _renderRow(el, items, showRank = false) {
    if (!el) return;
    if (!items.length) { el.innerHTML = '<p style="color:rgba(255,255,255,.35);padding:.5rem;font-size:.75rem">No items</p>'; return; }
    el.innerHTML = items.map((item, i) => _cardHtml(item, i, showRank)).join('');
    el.querySelectorAll('.mb-card-sm[data-movie-id]').forEach(card => {
      card.addEventListener('click', () => {
        if (!isHost) { showNotification('Only the host can select media', 'info'); return; }
        selectMovieBoxTitle(card.dataset.movieId);
      });
    });
  }

  // ── Render 3-col search results grid ───────────────────────
  function _renderGrid(el, items) {
    if (!el) return;
    if (!items.length) { el.innerHTML = '<p style="color:rgba(255,255,255,.4);padding:1rem;grid-column:1/-1;text-align:center;font-size:.8rem">No results found</p>'; return; }
    el.innerHTML = items.map((item, i) => _cardHtml(item, i, false)).join('');
    el.querySelectorAll('.mb-card-sm[data-movie-id]').forEach(card => {
      card.addEventListener('click', () => {
        if (!isHost) { showNotification('Only the host can select media', 'info'); return; }
        selectMovieBoxTitle(card.dataset.movieId);
      });
    });
  }

  // ── Update hero with real item ──────────────────────────────
  function _renderHero(item) {
    if (!hero || !item) return;
    hero.dataset.movieId = item.id;
    hero.dataset.title   = item.title;
    if (heroBg) {
      heroBg.innerHTML = '';
      if (item.cover) {
        const img = document.createElement('img');
        img.src = item.cover; img.className = 'mb-hero-cover-img'; img.alt = '';
        heroBg.appendChild(img);
      } else {
        heroBg.style.background = item.gradient || _MB_GRADIENTS[0];
      }
    }
    if (heroTitle) heroTitle.textContent = item.title;
    if (heroMeta)  heroMeta.textContent  = [item.year, item.lang, item.type].filter(Boolean).join(' · ');
    if (heroSk)    heroSk.style.display  = 'none';
    if (heroContent) heroContent.style.opacity = '1';
  }

  function _resetHero() {
    if (!hero) return;
    hero.dataset.movieId = ''; hero.dataset.title = '';
    if (heroBg) { heroBg.innerHTML = ''; heroBg.style.background = 'linear-gradient(135deg,#0d0d18 0%,#12122a 55%,#1a1a3e 100%)'; }
    if (heroContent) heroContent.style.opacity = '0';
    if (heroSk) heroSk.style.display = '';
  }

  // ── Filter rankings row by sub-pill ─────────────────────────
  function _applyRankFilter() {
    let items = _trendingItems;
    if (_activeRankCat !== 'all') {
      const filtered = items.filter(it => it.cat === _activeRankCat);
      items = filtered.length ? filtered : items; // fall back to all if nothing matches
    }
    _renderRow(rankingsRow, items.slice(0, 12), true);
  }

  // ── Fetch with cold-start retry logic ───────────────────────
  async function _fetchWithRetry(category, query, retryCount, onSuccess, onError) {
    const myVersion = ++_feedVersion;
    const { items, errorType } = await fetchMovieBoxFeed(category, query);
    if (_feedVersion !== myVersion) return;

    if (items?.length) { onSuccess(items); return; }

    // A timeout can be a cold Render start; a 5xx is an actual upstream
    // failure and should show the API-unavailable state instead of repeatedly
    // telling users that the server is waking up.
    const canRetry = errorType === 'timeout' && retryCount < MAX_RETRIES;
    if (canRetry) {
      _mbWakeCountdown(onError.el, retryCount + 1, MAX_RETRIES, () => {
        if (_feedVersion === myVersion) _fetchWithRetry(category, query, retryCount + 1, onSuccess, onError);
      });
    } else {
      _mbShowRowError(onError.el, errorType || 'unknown', () => {
        if (_feedVersion === myVersion) _fetchWithRetry(category, query, 0, onSuccess, onError);
      });
    }
  }

  // ── Load full home screen (trending + movies) ────────────────
  function _loadHome() {
    _resetHero();
    _skRow(featuredRow);
    _skRow(rankingsRow);
    _skRow(cinemaRow);
    _trendingItems = [];

    // Trending feed → hero + featured + rankings
    _fetchWithRetry(_activePill, '', 0,
      (items) => {
        _trendingItems = items;
        _renderHero(items[0]);
        _renderRow(featuredRow, items.slice(1, 8));
        _applyRankFilter();
      },
      { el: rankingsRow }
    );

    // Movies feed → Cinema section
    fetchMovieBoxFeed('movie').then(({ items, errorType }) => {
      if (items?.length) _renderRow(cinemaRow, items.slice(0, 12));
      else _mbShowRowError(cinemaRow, errorType || 'unknown', () => fetchMovieBoxFeed('movie').then(r => r.items?.length && _renderRow(cinemaRow, r.items.slice(0, 12))));
    });
  }

  // ── Search mode ──────────────────────────────────────────────
  function _enterSearch(q) {
    // homeSections now contains the hero, so hiding it hides both together
    if (homeSections) homeSections.style.display = 'none';
    if (searchResults) searchResults.style.display = '';
    if (resultsGrid) resultsGrid.innerHTML = '<p style="color:rgba(255,255,255,.4);padding:1rem;grid-column:1/-1;text-align:center;font-size:.8rem">Searching…</p>';

    async function _doSearch(retries) {
      const { items, errorType } = await fetchMovieBoxFeed('trending', q);
      if (items?.length) { _renderGrid(resultsGrid, items); return; }
      if (errorType === 'timeout' && retries > 0) {
        _mbWakeCountdown(resultsGrid, MAX_RETRIES - retries + 1, MAX_RETRIES, () => _doSearch(retries - 1));
      } else if (errorType === 'not_configured') {
        _mbShowRowError(resultsGrid, 'not_configured', () => _doSearch(MAX_RETRIES));
      } else if (errorType === 'network') {
        _mbShowRowError(resultsGrid, 'network', () => _doSearch(MAX_RETRIES));
      } else {
        _renderGrid(resultsGrid, []);
      }
    }
    _doSearch(MAX_RETRIES);
  }

  function _exitSearch() {
    if (homeSections) homeSections.style.display = '';
    if (searchResults) searchResults.style.display = 'none';
  }

  // ── Media modal tab switcher ─────────────────────────────────
  document.querySelectorAll('.media-modal-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.media-modal-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.mediaTab;
      const panelMap = { directUrl: 'mediaPanelDirectUrl', moviebox: 'mediaPanelMoviebox' };
      document.querySelectorAll('.media-tab-panel').forEach(p => (p.style.display = 'none'));
      const panel = document.getElementById(panelMap[target]);
      if (panel) panel.style.display = '';
      if (target === 'moviebox') {
        const notice = document.getElementById('mbGuestNotice');
        if (notice) notice.style.display = isHost ? 'none' : 'flex';
        _wakePing();
        _loadHome();
      }
    });
  });

  // ── Filter pills ─────────────────────────────────────────────
  document.querySelectorAll('.mb-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.mb-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      _activePill = pill.dataset.pill || pill.textContent.trim().toLowerCase();
      const mbSearch = document.getElementById('mbSearch');
      if (mbSearch) mbSearch.value = '';
      _exitSearch();
      _loadHome();
    });
  });

  // ── Category chips (client-side filter on featured + rankings) ─
  document.querySelectorAll('.mb-cat-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.mb-cat-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      _activeRankCat = chip.dataset.filter || 'all';
      _applyRankFilter();
      // Also filter featured row
      if (featuredRow) {
        featuredRow.querySelectorAll('.mb-card-sm[data-movie-id]').forEach(card => {
          const item = _trendingItems.find(it => it.id === card.dataset.movieId);
          card.style.display = (_activeRankCat === 'all' || (item && item.cat === _activeRankCat)) ? '' : 'none';
        });
      }
    });
  });

  // ── Rankings sub-pills ───────────────────────────────────────
  document.querySelectorAll('.mb-rank-subpill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.mb-rank-subpill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      _activeRankCat = pill.dataset.rankCat || 'all';
      _applyRankFilter();
    });
  });

  // ── Search input (debounced) ─────────────────────────────────
  const mbSearchEl = document.getElementById('mbSearch');
  const mbSearchBtn = document.getElementById('mbSearchBtn');
  const doSearch = () => {
    const q = mbSearchEl?.value.trim();
    if (q) _enterSearch(q);
    else _exitSearch();
  };
  mbSearchBtn?.addEventListener('click', doSearch);
  if (mbSearchEl) {
    mbSearchEl.addEventListener('input', () => {
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(() => {
        const q = mbSearchEl.value.trim();
        if (q) _enterSearch(q);
        else _exitSearch();
      }, 350);
    });
    mbSearchEl.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(_searchTimer); doSearch(); } });
  }

  // ── Hero click ───────────────────────────────────────────────
  if (hero) {
    hero.addEventListener('click', () => {
      if (!hero.dataset.movieId) return;
      if (!isHost) { showNotification('Only the host can select media', 'info'); return; }
      selectMovieBoxTitle(hero.dataset.movieId);
    });
  }
}

// ============================================================
// FIREBASE STATE
// ============================================================

async function updateFirebaseState(playState, currentTime, videoUrl = null) {
  if (!isHost) return; // only host writes sync state
  const updates = { playState, currentTime, lastUpdatedBy: userId, lastUpdatedAt: Date.now() };
  if (videoUrl !== null) {
    updates.videoUrl = videoUrl;
    // Switching to a direct/OTT/embed URL clears any active MovieBox selection so
    // every client's listener falls through to the videoUrl path, not the movieId path.
    updates.currentMovieId = null;
    currentMovieId = null; // mirror locally so our own listener stays consistent
  }
  try { await update(ref(db, `rooms/${roomId}`), updates); } catch {}
}

// ============================================================
// HOST UI
// ============================================================

function updateHostUI() {
  const hostPanel = document.getElementById('hostControlPanel');
  const hostBadge = document.getElementById('hostBadge');
  const hostSettings = document.getElementById('hostSettings');
  const nonHostMsg = document.getElementById('nonHostMessage');

  // Host control panel visibility
  if (hostPanel) hostPanel.style.display = isHost ? 'block' : 'none';
  if (hostBadge) hostBadge.style.display = isHost ? 'flex' : 'none';
  if (hostSettings) hostSettings.style.display = isHost ? 'block' : 'none';
  if (nonHostMsg) nonHostMsg.style.display = isHost ? 'none' : 'flex';

  // Show/hide host-only elements
  document.querySelectorAll('.host-only-el').forEach(el => {
    el.style.display = isHost ? '' : 'none';
  });

  // Update placeholder text for guests
  const placeholderSubtext = document.getElementById('placeholderSubtext');
  if (placeholderSubtext) {
    if (isHost) {
      placeholderSubtext.innerHTML = 'Tap <strong>Media</strong> to load a video, audio, or website URL';
    } else {
      placeholderSubtext.textContent = 'Waiting for the host to load media…';
    }
  }

  // Update HCP panel data
  if (isHost) {
    const hcpCode = document.getElementById('hcpCode');
    const hcpHostName = document.getElementById('hcpHostName');
    if (hcpCode) hcpCode.textContent = roomId;
    if (hcpHostName) hcpHostName.textContent = username;
    updateHCPMemberCount();
  }
}

function updateHCPMemberCount() {
  const el = document.getElementById('hcpMemberCount');
  if (el) el.textContent = Object.keys(cachedUsers).length;
}

function initHostControlPanel() {
  // Copy code
  const hcpCopyCode = document.getElementById('hcpCopyCode');
  if (hcpCopyCode) {
    hcpCopyCode.addEventListener('click', () => {
      navigator.clipboard.writeText(roomId)
        .then(() => showNotification('Room code copied!', 'success'))
        .catch(() => showNotification('Copy failed', 'error'));
    });
    hcpCopyCode.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') hcpCopyCode.click(); });
  }

  // Copy link
  const hcpCopyLink = document.getElementById('hcpCopyLink');
  if (hcpCopyLink) {
    hcpCopyLink.addEventListener('click', () => {
      const shareUrl = `${window.location.origin}/room.html?room=${roomId}`;
      navigator.clipboard.writeText(shareUrl)
        .then(() => showNotification('Invite link copied!', 'success'))
        .catch(() => showNotification('Copy failed', 'error'));
    });
  }

  // Accent colour swatches
  const swatchContainer = document.getElementById('hcpSwatches');
  if (swatchContainer) {
    ACCENT_COLORS.forEach(color => {
      const btn = document.createElement('button');
      btn.className = 'hcp-swatch' + (color === currentAccentColor ? ' active' : '');
      btn.style.background = color;
      btn.title = color;
      btn.addEventListener('click', async () => {
        currentAccentColor = color;
        swatchContainer.querySelectorAll('.hcp-swatch').forEach(s => s.classList.toggle('active', s.title === color));
        applyAccentColor(color);
        try { await update(ref(db, `rooms/${roomId}`), { accentColor: color }); } catch {}
      });
      swatchContainer.appendChild(btn);
    });
  }
}

function applyAccentColor(color) {
  if (!color) return;
  document.documentElement.style.setProperty('--primary', color);
  // Derive a darker shade for hover
  document.documentElement.style.setProperty('--primary-hover', color + 'cc');
  document.documentElement.style.setProperty('--glow', color + '55');
  document.documentElement.style.setProperty('--glow-sm', color + '33');
}

// ============================================================
// MUTE BUTTON
// ============================================================

function initMuteButton() {
  const muteBtn = document.getElementById('muteBtn');
  if (!muteBtn) return;

  muteBtn.addEventListener('click', () => {
    isVideoMuted = !isVideoMuted;

    // Apply to video element
    if (videoPlayer) videoPlayer.muted = isVideoMuted;

    // Apply to YouTube (set volume to 0 / restore)
    if (youtubePlayer && ytReady) {
      if (isVideoMuted) youtubePlayer.mute();
      else youtubePlayer.unMute();
    }

    // Apply to audio elements in chat
    document.querySelectorAll('audio').forEach(a => { a.muted = isVideoMuted; });

    // Try to mute/unmute iframe embeds via postMessage (best-effort, cross-origin)
    const IFRAME_IDS = ['embedFrame', 'ottEmbedFrame', 'driveFrame', 'vimeoPlayer', 'dailymotionPlayer'];
    for (const id of IFRAME_IDS) {
      const fr = document.getElementById(id);
      if (!fr?.contentWindow) continue;
      const vol = isVideoMuted ? 0 : 1;
      try { fr.contentWindow.postMessage({ volume: vol }, '*'); } catch {}
      try { fr.contentWindow.postMessage(JSON.stringify({ method: 'setVolume', value: vol * 100 }), '*'); } catch {}
      try { fr.contentWindow.postMessage(JSON.stringify({ command: isVideoMuted ? 'mute' : 'unmute' }), '*'); } catch {}
      try { fr.contentWindow.postMessage({ event: isVideoMuted ? 'mute' : 'unmute' }, '*'); } catch {}
    }

    // Toggle icons
    const iconUnmuted = muteBtn.querySelector('.icon-unmuted');
    const iconMuted = muteBtn.querySelector('.icon-muted');
    if (iconUnmuted) iconUnmuted.style.display = isVideoMuted ? 'none' : '';
    if (iconMuted) iconMuted.style.display = isVideoMuted ? '' : 'none';

    muteBtn.classList.toggle('muted', isVideoMuted);
    muteBtn.title = isVideoMuted ? 'Unmute' : 'Mute';
    showNotification(isVideoMuted ? 'Muted' : 'Unmuted', 'info');
  });
}

// ============================================================
// LANGUAGE / AUDIO TRACK SELECTOR
// ============================================================

function formatLangName(code) {
  if (!code) return '';
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code.toUpperCase();
  } catch { return code.toUpperCase(); }
}

function _detectHlsTracks() {
  if (!hlsInstance) return;
  const audioTracks = (hlsInstance.audioTracks || []).map((t, i) => ({
    id: t.id !== undefined ? t.id : i,
    name: t.name || formatLangName(t.lang) || `Track ${i + 1}`,
    lang: t.lang || '',
    default: !!(t.default || i === 0)
  }));
  const subTracks = (hlsInstance.subtitleTracks || []).map((t, i) => ({
    id: t.id !== undefined ? t.id : i,
    name: t.name || formatLangName(t.lang) || `Sub ${i + 1}`,
    lang: t.lang || ''
  }));
  if (audioTracks.length > 1 || subTracks.length > 0) {
    currentAudioTrackId = hlsInstance.audioTrack >= 0 ? hlsInstance.audioTrack : 0;
    currentSubtitleTrackId = -1;
    populateLangSelector(audioTracks, subTracks);
  }
}

function populateLangSelector(audioTracks, subtitleTracks) {
  availableAudioTracks = audioTracks || [];
  availableSubtitleTracks = subtitleTracks || [];

  const selector = document.getElementById('langSelector');
  const audioOpts = document.getElementById('langAudioOptions');
  const subOpts = document.getElementById('langSubOptions');
  const subSection = document.getElementById('langSubSection');
  const audioSection = document.getElementById('langAudioSection');
  if (!selector) return;

  const hasAudio = availableAudioTracks.length > 1;
  const hasSubs = availableSubtitleTracks.length > 0;
  if (!hasAudio && !hasSubs) { selector.style.display = 'none'; return; }

  selector.style.display = '';

  // ---- Audio tracks ----
  if (audioOpts && audioSection) {
    audioOpts.innerHTML = '';
    audioSection.style.display = hasAudio ? '' : 'none';
    if (hasAudio) {
      availableAudioTracks.forEach(track => {
        const btn = document.createElement('button');
        const isActive = track.id === currentAudioTrackId || (currentAudioTrackId === -1 && track.default);
        btn.className = 'lang-option' + (isActive ? ' active' : '');
        btn.dataset.trackId = track.id;
        const code = track.lang ? track.lang.split('-')[0].toUpperCase() : String(track.id + 1);
        const label = track.name || formatLangName(track.lang) || `Track ${track.id + 1}`;
        btn.innerHTML = `<span class="lang-option-code">${code}</span><span class="lang-option-name">${escapeHtml(label)}</span><svg class="lang-check" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
        btn.addEventListener('click', e => { e.stopPropagation(); switchAudioTrack(track.id); });
        audioOpts.appendChild(btn);
      });
    }
  }

  // ---- Subtitle tracks ----
  if (subOpts && subSection) {
    subOpts.innerHTML = '';
    subSection.style.display = hasSubs ? '' : 'none';
    if (hasSubs) {
      // "Off" option
      const offBtn = document.createElement('button');
      offBtn.className = 'lang-option' + (currentSubtitleTrackId === -1 ? ' active' : '');
      offBtn.dataset.trackId = -1;
      offBtn.innerHTML = `<span class="lang-option-code">—</span><span class="lang-option-name">Off</span><svg class="lang-check" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
      offBtn.addEventListener('click', e => { e.stopPropagation(); switchSubtitleTrack(-1); });
      subOpts.appendChild(offBtn);
      availableSubtitleTracks.forEach(track => {
        const btn = document.createElement('button');
        btn.className = 'lang-option' + (track.id === currentSubtitleTrackId ? ' active' : '');
        btn.dataset.trackId = track.id;
        const code = track.lang ? track.lang.split('-')[0].toUpperCase() : String(track.id + 1);
        const label = track.name || formatLangName(track.lang) || `Sub ${track.id + 1}`;
        btn.innerHTML = `<span class="lang-option-code">${code}</span><span class="lang-option-name">${escapeHtml(label)}</span><svg class="lang-check" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
        btn.addEventListener('click', e => { e.stopPropagation(); switchSubtitleTrack(track.id); });
        subOpts.appendChild(btn);
      });
    }
  }

  // Update button label to current active lang code
  _updateLangBtnLabel();
}

function _updateLangBtnLabel() {
  const labelEl = document.getElementById('langBtnLabel');
  if (!labelEl) return;
  const track = availableAudioTracks.find(t => t.id === currentAudioTrackId)
    || availableAudioTracks.find(t => t.default)
    || availableAudioTracks[0];
  if (track) {
    const code = track.lang ? track.lang.split('-')[0].toUpperCase() : String(track.id + 1);
    labelEl.textContent = code.length > 3 ? code.slice(0, 3) : code;
  } else {
    labelEl.textContent = 'Audio';
  }
}

function switchAudioTrack(id) {
  currentAudioTrackId = id;

  // HLS.js — no seek/pause needed, instant switch
  if (hlsInstance) {
    try { hlsInstance.audioTrack = id; } catch {}
  }

  // Native HTMLVideoElement.audioTracks (Safari / some Chromium builds)
  if (videoPlayer && videoPlayer.audioTracks && videoPlayer.audioTracks.length > 1) {
    for (let i = 0; i < videoPlayer.audioTracks.length; i++) {
      videoPlayer.audioTracks[i].enabled = (i === id);
    }
  }

  // Update active highlight
  document.querySelectorAll('#langAudioOptions .lang-option').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.trackId) === id);
  });
  _updateLangBtnLabel();

  const track = availableAudioTracks.find(t => t.id === id);
  const name = track ? (track.name || formatLangName(track.lang) || `Track ${id + 1}`) : `Track ${id + 1}`;
  showNotification('Audio: ' + name, 'success');
}

function switchSubtitleTrack(id) {
  currentSubtitleTrackId = id;

  // HLS.js subtitles (-1 = off)
  if (hlsInstance) {
    try { hlsInstance.subtitleTrack = id; } catch {}
  }

  // Native HTML5 TextTracks
  if (videoPlayer && videoPlayer.textTracks) {
    for (let i = 0; i < videoPlayer.textTracks.length; i++) {
      const tt = videoPlayer.textTracks[i];
      if (tt.kind === 'subtitles' || tt.kind === 'captions') {
        tt.mode = (i === id) ? 'showing' : 'hidden';
      }
    }
  }

  // Update active highlight
  document.querySelectorAll('#langSubOptions .lang-option').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.trackId) === id);
  });

  if (id === -1) {
    showNotification('Subtitles off', 'info');
  } else {
    const track = availableSubtitleTracks.find(t => t.id === id);
    const name = track ? (track.name || formatLangName(track.lang) || `Sub ${id + 1}`) : `Sub ${id + 1}`;
    showNotification('Subtitles: ' + name, 'success');
  }
}

function initLangSelector() {
  const langBtn = document.getElementById('langBtn');
  const langPanel = document.getElementById('langPanel');
  if (!langBtn || !langPanel) return;

  langBtn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = langPanel.classList.contains('active');
    // Close quality dropdown if open
    document.getElementById('qualityDropdown')?.classList.remove('active');
    langPanel.classList.toggle('active', !isOpen);
  });

  // Close on outside click
  document.addEventListener('click', e => {
    const sel = document.getElementById('langSelector');
    if (sel && !sel.contains(e.target)) {
      langPanel.classList.remove('active');
    }
  });
}

// ============================================================
// DRIVE SUBTITLE OVERLAY
// ============================================================

function _parseVtt(text) {
  const cues = [];
  const blocks = text.replace(/\r\n/g, '\n').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    let ti = -1;
    for (let i = 0; i < lines.length; i++) { if (lines[i].includes('-->')) { ti = i; break; } }
    if (ti === -1) continue;
    const m = lines[ti].match(/(\d{1,2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3})/);
    if (!m) continue;
    const pt = s => { const p = s.replace(',', '.').split(':'); return (+p[0]) * 3600 + (+p[1]) * 60 + parseFloat(p[2]); };
    const t = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (t) cues.push({ start: pt(m[1]), end: pt(m[2]), text: t });
  }
  return cues;
}

function _parseSrt(text) {
  const cues = [];
  const blocks = text.replace(/\r\n/g, '\n').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    let ti = -1;
    for (let i = 0; i < lines.length; i++) { if (lines[i].includes('-->')) { ti = i; break; } }
    if (ti === -1) continue;
    const m = lines[ti].match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
    if (!m) continue;
    const pt = s => { const p = s.replace(',', '.').split(':'); return (+p[0]) * 3600 + (+p[1]) * 60 + parseFloat(p[2]); };
    const t = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (t) cues.push({ start: pt(m[1]), end: pt(m[2]), text: t });
  }
  return cues;
}

function _getDriveEstimatedTime() {
  if (!lastRoomData) return 0;
  let t = lastRoomData.currentTime || 0;
  if (lastRoomData.playState === 'playing' && lastRoomData.lastUpdatedAt) {
    t += Math.min((Date.now() - lastRoomData.lastUpdatedAt) / 1000, 120);
  }
  return t;
}

function clearDriveSubtitleOverlay() {
  if (driveSubInterval) { clearInterval(driveSubInterval); driveSubInterval = null; }
  driveVttCues = [];
  const overlay = document.getElementById('driveSubOverlay');
  if (overlay) overlay.remove();
}

function _ensureDriveSubOverlay() {
  let overlay = document.getElementById('driveSubOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'driveSubOverlay';
    overlay.style.cssText = 'position:absolute;bottom:64px;left:0;right:0;text-align:center;z-index:50;pointer-events:none;padding:0 1rem;';
    const span = document.createElement('span');
    span.id = 'driveSubText';
    span.style.cssText = 'display:inline-block;background:rgba(0,0,0,.78);color:#fff;padding:.28rem .8rem;border-radius:4px;font-size:1.05rem;line-height:1.55;max-width:90%;white-space:pre-line;text-shadow:0 1px 3px rgba(0,0,0,.9);visibility:hidden;';
    overlay.appendChild(span);
    const vc = document.getElementById('videoContainer');
    if (vc) vc.appendChild(overlay);
  }
  return overlay;
}

async function loadDriveSubtitleUrl(url) {
  if (!url) return false;
  clearDriveSubtitleOverlay();
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const isVtt = text.trim().toUpperCase().startsWith('WEBVTT') || /\.vtt(\?|$)/i.test(url);
    driveVttCues = isVtt ? _parseVtt(text) : _parseSrt(text);
    if (!driveVttCues.length) { showNotification('No subtitle cues found in file', 'error'); return false; }
    _ensureDriveSubOverlay();
    driveSubInterval = setInterval(() => {
      const t = _getDriveEstimatedTime();
      const cue = driveVttCues.find(c => t >= c.start && t <= c.end) || null;
      const el = document.getElementById('driveSubText');
      if (el) { el.textContent = cue ? cue.text : ''; el.style.visibility = cue ? 'visible' : 'hidden'; }
    }, 200);
    showNotification(`Subtitles loaded (${driveVttCues.length} cues)`, 'success');
    return true;
  } catch (e) {
    showNotification('Failed to load subtitles: ' + e.message, 'error');
    return false;
  }
}

function setupDriveSubtitlePanel() {
  const selector  = document.getElementById('langSelector');
  const audioSec  = document.getElementById('langAudioSection');
  const subSec    = document.getElementById('langSubSection');
  const subOpts   = document.getElementById('langSubOptions');
  const header    = document.querySelector('#langPanel .lang-panel-header span');
  const labelEl   = document.getElementById('langBtnLabel');
  if (!selector) return;

  selector.style.display = '';
  if (audioSec)  audioSec.style.display  = 'none';
  if (subSec)    subSec.style.display    = '';
  if (header)    header.textContent      = 'Subtitles';
  if (labelEl)   labelEl.textContent     = 'SUB';

  if (!subOpts) return;
  subOpts.innerHTML = '';

  // — Off button —
  const offBtn = document.createElement('button');
  offBtn.className = 'lang-option active';
  offBtn.dataset.subCode = 'off';
  offBtn.innerHTML = `<span class="lang-option-code">—</span><span class="lang-option-name">Off</span><svg class="lang-check" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
  offBtn.addEventListener('click', e => {
    e.stopPropagation();
    clearDriveSubtitleOverlay();
    subOpts.querySelectorAll('.lang-option[data-sub-code]').forEach(b => b.classList.remove('active'));
    offBtn.classList.add('active');
    showNotification('Subtitles off', 'info');
  });
  subOpts.appendChild(offBtn);

  // — Language buttons —
  EMBED_AUDIO_LANGS.forEach(lang => {
    const btn = document.createElement('button');
    btn.className = 'lang-option';
    btn.dataset.subCode = lang.code;
    btn.innerHTML = `<span class="lang-option-code">${lang.code.toUpperCase()}</span><span class="lang-option-name">${lang.name}</span><svg class="lang-check" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const inp = document.getElementById('driveSubUrlInput');
      if (inp) { inp.placeholder = `Paste .vtt or .srt URL for ${lang.name}…`; inp.focus(); }
    });
    subOpts.appendChild(btn);
  });

  // — URL input row —
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:.35rem;padding:.55rem .6rem .4rem;border-top:1px solid rgba(255,255,255,.07);margin-top:.3rem;';
  const inp = document.createElement('input');
  inp.id = 'driveSubUrlInput';
  inp.type = 'url';
  inp.placeholder = 'Paste .vtt or .srt subtitle URL…';
  inp.style.cssText = 'flex:1;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:.35rem .5rem;color:var(--text);font-size:.74rem;outline:none;min-width:0;';
  const loadBtn = document.createElement('button');
  loadBtn.textContent = 'Load';
  loadBtn.style.cssText = 'background:var(--primary);color:#1a1a2e;border:none;border-radius:6px;padding:.35rem .72rem;font-size:.74rem;font-weight:700;cursor:pointer;white-space:nowrap;';
  loadBtn.addEventListener('click', async e => {
    e.stopPropagation();
    const url = inp.value.trim();
    if (!url) { showNotification('Enter a subtitle URL', 'error'); return; }
    loadBtn.textContent = '…';
    loadBtn.disabled = true;
    const ok = await loadDriveSubtitleUrl(url);
    loadBtn.textContent = 'Load';
    loadBtn.disabled = false;
    if (ok) {
      // Highlight matching language if detectable
      const guess = EMBED_AUDIO_LANGS.find(l =>
        new RegExp('[._/-]' + l.code + '[._/-]', 'i').test(url) ||
        new RegExp('[._/-]' + l.code + '$', 'i').test(url.replace(/\?.*$/, ''))
      );
      subOpts.querySelectorAll('.lang-option[data-sub-code]').forEach(b => b.classList.remove('active'));
      if (guess) {
        subOpts.querySelectorAll(`.lang-option[data-sub-code="${guess.code}"]`).forEach(b => b.classList.add('active'));
      }
    }
  });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); loadBtn.click(); } });
  row.appendChild(inp);
  row.appendChild(loadBtn);
  subOpts.appendChild(row);
}

// ============================================================
// EMBED LANGUAGE SELECTOR (for iframe-based content)
// ============================================================

const EMBED_AUDIO_LANGS = [
  { code: 'hi', name: 'Hindi' },
  { code: 'en', name: 'English' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'kn', name: 'Kannada' },
  { code: 'bn', name: 'Bengali' },
  { code: 'mr', name: 'Marathi' },
  { code: 'pa', name: 'Punjabi' },
  { code: 'gu', name: 'Gujarati' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ar', name: 'Arabic' },
  { code: 'ru', name: 'Russian' },
  { code: 'tr', name: 'Turkish' },
];

/**
 * Apply audio-dub and subtitle language params to an embed URL.
 *
 * autoembed.co  → audio: ?primaryLang=CODE   subtitle: ?secondaryLang=CODE
 * vidlink.pro   → audio: ?lang=CODE           subtitle: ?sub=1 (enables sub track)
 *
 * Passing null for a param leaves it untouched.
 * Passing 'off' for subLang removes subtitle params (disables subs).
 */
function _applyEmbedParams(url, audioLang, subLang) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isDub = audioLang && audioLang !== 'ja'; // any non-Japanese = dubbed

    // ── Audio / Dub ───────────────────────────────────���──────
    if (audioLang) {
      if (host.includes('vidsrc.xyz')) {
        // vidsrc.xyz: ?dub=1 switches to dubbed audio; ds_lang selects track
        u.searchParams.set('ds_lang', audioLang);
        if (isDub) { u.searchParams.set('dub', '1'); }
        else        { u.searchParams.delete('dub');  }
      } else if (host.includes('vidlink.')) {
        u.searchParams.set('lang', audioLang);
        u.searchParams.set('primaryLang', audioLang);
        if (isDub) { u.searchParams.set('dub', '1'); }
        else        { u.searchParams.delete('dub');  }
      } else {
        // autoembed.co and any other provider
        u.searchParams.set('primaryLang', audioLang);
        // Extra flags recognised by secondary providers (silently ignored if unsupported)
        if (isDub) {
          u.searchParams.set('dub', '1');
          u.searchParams.set('dubbed', 'true');
        } else {
          u.searchParams.delete('dub');
          u.searchParams.delete('dubbed');
        }
      }
    }

    // ── Subtitles ────────────────────────────────────────────
    if (subLang === 'off') {
      u.searchParams.delete('secondaryLang');
      u.searchParams.delete('sub');
      u.searchParams.delete('subLang');
    } else if (subLang) {
      if (host.includes('vidlink.')) {
        // vidlink: sub=1 enables subtitles, subLang=CODE selects the language
        u.searchParams.set('sub', '1');
        u.searchParams.set('subLang', subLang);
      } else {
        // autoembed.co / vidsrc.xyz and others
        u.searchParams.set('secondaryLang', subLang);
      }
    }

    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    let result = url;
    if (audioLang) {
      result += `${sep}primaryLang=${audioLang}`;
      if (audioLang !== 'ja') result += `&dub=1&dubbed=true`;
    }
    return result;
  }
}

// Keep old name as thin alias so any remaining call sites still work
function _applyEmbedLangParam(url, langCode) {
  return _applyEmbedParams(url, langCode, currentEmbedSubLang);
}

// (embed shield removed — ad-link blocking is handled silently via iframe sandbox)

/**
 * Parse audio + subtitle lang codes already baked into an embed URL.
 * Returns { audio, sub } — each may be null.
 * Keeps state in sync when a URL arrives pre-parameterised (e.g. Firebase guest sync).
 */
function _parseEmbedParamsFromUrl(url) {
  try {
    const u = new URL(url);
    return {
      audio: u.searchParams.get('primaryLang') || u.searchParams.get('lang') || null,
      sub:   u.searchParams.get('secondaryLang') || null,
    };
  } catch { return { audio: null, sub: null }; }
}
// Keep old name as alias
function _parseLangFromUrl(url) { return _parseEmbedParamsFromUrl(url).audio; }

/**
 * Show the language + subtitle selector for embed (iframe) content.
 * Called whenever an OTT / anime / direct embed iframe is loaded.
 */
function populateEmbedLangSelector() {
  isEmbedLangMode = true;
  const selector   = document.getElementById('langSelector');
  const audioOpts  = document.getElementById('langAudioOptions');
  const audioSection = document.getElementById('langAudioSection');
  const subSection   = document.getElementById('langSubSection');
  const subOpts      = document.getElementById('langSubOptions');
  if (!selector || !audioOpts) return;

  selector.style.display = '';
  if (audioSection) audioSection.style.display = '';
  if (subSection)   subSection.style.display   = '';   // show subtitle section for embeds

  // ── Audio / Dub options ──────────────────────────────────
  audioOpts.innerHTML = '';
  EMBED_AUDIO_LANGS.forEach(lang => {
    const btn = document.createElement('button');
    const isActive = currentEmbedLang === lang.code;
    const isHindi = lang.code === 'hi';
    btn.className = 'lang-option' + (isActive ? ' active' : '') + (isHindi ? ' lang-option-featured' : '');
    btn.dataset.langCode = lang.code;
    const badge = isHindi ? '<span class="lang-dub-badge">DUB ★</span>' : '';
    btn.innerHTML = `<span class="lang-option-code">${lang.code.toUpperCase()}</span><span class="lang-option-name">${lang.name}${badge}</span><svg class="lang-check" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    btn.addEventListener('click', e => { e.stopPropagation(); switchEmbedLang(lang.code); });
    audioOpts.appendChild(btn);
  });

  // ── Subtitle options ─────────────────────────────────────
  if (subOpts) {
    subOpts.innerHTML = '';

    // "Off" button
    const offBtn = document.createElement('button');
    const subIsOff = !currentEmbedSubLang || currentEmbedSubLang === 'off';
    offBtn.className = 'lang-option' + (subIsOff ? ' active' : '');
    offBtn.dataset.subCode = 'off';
    offBtn.innerHTML = `<span class="lang-option-code">—</span><span class="lang-option-name">Off</span><svg class="lang-check" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    offBtn.addEventListener('click', e => { e.stopPropagation(); switchEmbedSubtitle('off'); });
    subOpts.appendChild(offBtn);

    EMBED_AUDIO_LANGS.forEach(lang => {
      const btn = document.createElement('button');
      const isActive = currentEmbedSubLang === lang.code;
      btn.className = 'lang-option' + (isActive ? ' active' : '');
      btn.dataset.subCode = lang.code;
      btn.innerHTML = `<span class="lang-option-code">${lang.code.toUpperCase()}</span><span class="lang-option-name">${lang.name}</span><svg class="lang-check" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
      btn.addEventListener('click', e => { e.stopPropagation(); switchEmbedSubtitle(lang.code); });
      subOpts.appendChild(btn);
    });
  }

  // If a language/sub was already selected (persisted), apply to iframe if not already applied
  // (needed for synced guests whose iframe src came from Firebase without params)
  const iframeEl = document.getElementById('embedFrame') || document.getElementById('ottEmbedFrame');
  if (iframeEl && (currentEmbedLang || currentEmbedSubLang)) {
    const parsed = _parseEmbedParamsFromUrl(iframeEl.src);
    if (!parsed.audio && !parsed.sub) {
      const newSrc = _applyEmbedParams(iframeEl.src, currentEmbedLang, currentEmbedSubLang);
      iframeEl.src = newSrc;
      currentVideoUrl = newSrc;
    }
  }

  // Update button label
  const labelEl = document.getElementById('langBtnLabel');
  if (labelEl) labelEl.textContent = currentEmbedLang ? currentEmbedLang.toUpperCase() : 'AUDIO';

  // Update panel / section titles
  const header = document.querySelector('#langPanel .lang-panel-header span');
  if (header) header.textContent = 'Audio & Subtitles';
  const audioTitle = document.querySelector('#langAudioSection .lang-section-title');
  if (audioTitle) audioTitle.textContent = 'Dubbing / Audio Language';
  const subTitle = document.querySelector('#langSubSection .lang-section-title');
  if (subTitle) subTitle.textContent = 'Subtitles';
}

/**
 * Reload an embed iframe with a new URL while preserving playback position.
 *
 * Behaviour:
 *  1. Snapshots the live position (embedCurrentOffset + elapsed) before reload.
 *  2. Immediately pushes 'paused' + new URL + correct position to Firebase so
 *     any late-joining guest that loads during the reload gap knows where to seek.
 *  3. If playback was active, attaches a one-shot 'load' listener that — after
 *     the embed player has had time to initialise — seeks to the saved position,
 *     sends play, restores embedPlayStartTime, and re-broadcasts 'playing' to
 *     Firebase so the periodic sync interval resumes and live guests re-sync.
 *
 * Called only when isHost is true.
 */
function _reloadEmbedAndResync(iframeEl, newUrl) {
  // Snapshot live position before the iframe reloads to position 0
  const livePos = embedPlayStartTime
    ? embedCurrentOffset + (Date.now() - embedPlayStartTime) / 1000
    : embedCurrentOffset;
  const wasPlaying = !!embedPlayStartTime;

  // Freeze tracking while the iframe is reloading
  embedCurrentOffset = livePos;
  embedPlayStartTime = null;

  // Tell Firebase the new URL + position straight away.
  // Using 'paused' so guests wait rather than attempting to play a blank frame.
  updateFirebaseState('paused', livePos, newUrl);

  // Trigger the reload
  iframeEl.src = newUrl;
  currentVideoUrl = newUrl;

  if (wasPlaying) {
    // Restore playback once the embed player has initialised
    const onIframeLoad = () => {
      iframeEl.removeEventListener('load', onIframeLoad);
      // Give the embed ~1.5 s to initialise its internal player before sending commands
      setTimeout(() => {
        const seekTo = embedCurrentOffset; // livePos frozen above
        if (seekTo > 2) sendIframeCommand('seek', seekTo);
        sendIframeCommand('play');
        embedPlayStartTime = Date.now(); // restart elapsed tracking from here
        // Re-broadcast 'playing' so:
        //   • the periodic sync interval has a valid embedPlayStartTime to use
        //   • live guests receive a play command and seek to the correct position
        updateFirebaseState('playing', embedCurrentOffset);
        // Restart the periodic interval if it was cleared (e.g. after an earlier pause)
        if (!syncInterval) {
          syncInterval = setInterval(() => {
            if (!isHost) { clearInterval(syncInterval); syncInterval = null; return; }
            if (!videoPlayer && !youtubePlayer && embedPlayStartTime) {
              const pos = embedCurrentOffset + (Date.now() - embedPlayStartTime) / 1000;
              updateFirebaseState('playing', pos);
            }
          }, SYNC_INTERVAL_MS);
        }
      }, 1500);
    };
    iframeEl.addEventListener('load', onIframeLoad);
  }
}

/**
 * Switch embed audio/dub language, reload iframe with updated params.
 */
function switchEmbedLang(langCode) {
  currentEmbedLang = langCode;
  localStorage.setItem('wotchly_embed_lang', langCode);

  const iframeEl = document.getElementById('embedFrame') || document.getElementById('ottEmbedFrame');
  if (iframeEl) {
    const newUrl = _applyEmbedParams(iframeEl.src, langCode, currentEmbedSubLang);
    if (isHost) {
      _reloadEmbedAndResync(iframeEl, newUrl);
    } else {
      // Guests: just apply the new URL (host will push the updated state via Firebase)
      iframeEl.src = newUrl;
      currentVideoUrl = newUrl;
    }
  }

  document.querySelectorAll('#langAudioOptions .lang-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.langCode === langCode);
  });
  const labelEl = document.getElementById('langBtnLabel');
  if (labelEl) labelEl.textContent = langCode.toUpperCase();

  const found = EMBED_AUDIO_LANGS.find(l => l.code === langCode);
  showNotification(`Audio: ${found ? found.name : langCode} — reloading stream…`, 'info');
}

/**
 * Switch embed subtitle language, reload iframe with updated params.
 * @param {string} langCode  lang code (e.g. 'en', 'hi') or 'off' to disable
 */
function switchEmbedSubtitle(langCode) {
  currentEmbedSubLang = langCode;
  localStorage.setItem('wotchly_embed_sub_lang', langCode);

  const iframeEl = document.getElementById('embedFrame') || document.getElementById('ottEmbedFrame');
  if (iframeEl) {
    const newUrl = _applyEmbedParams(iframeEl.src, currentEmbedLang, langCode);
    if (isHost) {
      _reloadEmbedAndResync(iframeEl, newUrl);
    } else {
      iframeEl.src = newUrl;
      currentVideoUrl = newUrl;
    }
  }

  document.querySelectorAll('#langSubOptions .lang-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.subCode === langCode);
  });

  if (langCode === 'off') {
    showNotification('Subtitles off — reloading stream…', 'info');
  } else {
    const found = EMBED_AUDIO_LANGS.find(l => l.code === langCode);
    showNotification(`Subtitles: ${found ? found.name : langCode} — reloading stream…`, 'info');
  }
}

// ============================================================
// SYNC HELPERS
// ============================================================

/**
 * Compute the target sync position, compensating for elapsed time since host wrote to RTDB.
 * This ensures new viewers jump to where the host currently is, not where they were.
 */
/**
 * Compare two video URLs while ignoring embed language/subtitle params.
 * This allows guests to maintain their own language preference independently
 * of the host — the lang params are personal and shouldn't trigger a video reload.
 */
function _videoUrlMatches(url1, url2) {
  if (!url1 || !url2) return url1 === url2;
  if (url1 === url2) return true;
  try {
    const LANG_PARAMS = ['primaryLang', 'lang', 'secondaryLang', 'sub', 'subLang'];
    const strip = u => {
      const p = new URL(u);
      LANG_PARAMS.forEach(k => p.searchParams.delete(k));
      return p.toString();
    };
    return strip(url1) === strip(url2);
  } catch { return false; }
}

function computeSyncTarget(data) {
  if (!data || data.currentTime == null) return 0;
  let target = data.currentTime;
  if (data.playState === 'playing' && data.lastUpdatedAt) {
    const elapsed = (Date.now() - data.lastUpdatedAt) / 1000;
    // Cap elapsed to 60s to avoid wild jumps on reconnect
    target = data.currentTime + Math.min(elapsed, 60);
  }
  return Math.max(0, target);
}

function applyVideoSync(data) {
  if (!data || data.lastUpdatedBy === userId) return;

  const target = computeSyncTarget(data);

  if (videoPlayer) {
    const current = videoPlayer.currentTime;
    const diff = target - current;
    // Sync forward if > threshold, or sync backward only if > 8s behind
    if (Math.abs(diff) > SYNC_THRESHOLD && (diff > 0 || diff < -8)) {
      videoPlayer.currentTime = Math.min(target, videoPlayer.duration || Infinity);
    }
    if (data.playState === 'playing' && videoPlayer.paused && !isManuallyPaused) {
      videoPlayer.play().catch(() => {});
    } else if (data.playState === 'paused' && !videoPlayer.paused) {
      videoPlayer.pause();
    }
  }

  if (youtubePlayer && ytReady && typeof youtubePlayer.seekTo === 'function') {
    const ytTime = youtubePlayer.getCurrentTime();
    const diff = target - ytTime;
    if (Math.abs(diff) > SYNC_THRESHOLD && (diff > 0 || diff < -8)) {
      youtubePlayer.seekTo(target, true);
    }
    const state = youtubePlayer.getPlayerState();
    if (data.playState === 'playing' && state !== YT.PlayerState.PLAYING && !isManuallyPaused) {
      youtubePlayer.playVideo();
    } else if (data.playState === 'paused' && state === YT.PlayerState.PLAYING) {
      youtubePlayer.pauseVideo();
    }
  }

  // Iframe embed sync (for guests watching Drive/OTT/vidsrc embeds)
  if (!videoPlayer && !youtubePlayer) {
    // Defer to the iframe load handler when a new iframe is still initialising.
    // BUT: refresh pendingInitialSync with the latest Firebase data so the load
    // handler sees the most recent play state (fixes the race where host pushes
    // 'playing' ~1.5s after 'paused' while the guest iframe is still loading).
    if (pendingInitialSync) { pendingInitialSync = data; return; }
    if (data.playState === 'playing' && !isManuallyPaused) {
      // Send postMessage play — works for embed providers (vidsrc etc.) that accept it.
      sendIframeCommand('play');
      // Show tap-to-sync overlay so the browser autoplay policy is satisfied
      // for cross-origin iframes that can't be triggered without a user gesture.
      showSyncOverlay();
      updateSyncBadge('syncing');
      // Attempt seek if significantly out of sync
      const diff = target - embedCurrentOffset;
      if (Math.abs(diff) > SYNC_THRESHOLD && (diff > 0 || diff < -8)) {
        sendIframeCommand('seek', target);
        embedCurrentOffset = target;
        embedPlayStartTime = Date.now();
      }
    } else if (data.playState === 'paused') {
      hideSyncOverlay();
      updateSyncBadge('synced');
      sendIframeCommand('pause');
      if (embedPlayStartTime) {
        embedCurrentOffset += (Date.now() - embedPlayStartTime) / 1000;
        embedPlayStartTime = null;
      }
    }
  }
}

// ============================================================
// ============================================================
// SYNC OVERLAY & BADGE  (viewers only)
// ============================================================

let _syncOverlayShown = false;

function showSyncOverlay() {
  if (isHost || _syncOverlayShown) return;
  const overlay = document.getElementById('syncOverlay');
  if (!overlay) return;
  _syncOverlayShown = true;
  overlay.style.display = 'flex';
  requestAnimationFrame(() => overlay.classList.add('active'));

  const btn = document.getElementById('syncTapBtn');
  if (btn) {
    btn.onclick = () => {
      hideSyncOverlay();
      isManuallyPaused = false;
      sendIframeCommand('play');
      if (!embedPlayStartTime) embedPlayStartTime = Date.now();
      updateSyncBadge('synced');
    };
  }
}

function hideSyncOverlay() {
  _syncOverlayShown = false;
  const overlay = document.getElementById('syncOverlay');
  if (!overlay) return;
  overlay.classList.remove('active');
  setTimeout(() => { if (!overlay.classList.contains('active')) overlay.style.display = 'none'; }, 300);
}

function updateSyncBadge(state) {
  if (isHost) return;
  const badge = document.getElementById('syncBadge');
  const text  = document.getElementById('syncBadgeText');
  if (!badge || !text) return;
  if (state === 'hidden') { badge.style.display = 'none'; return; }
  badge.style.display = 'flex';
  badge.className = `sync-badge sync-badge--${state}`;
  text.textContent  = state === 'synced' ? 'Synced' : 'Syncing…';
  if (state === 'synced') {
    clearTimeout(badge._hideTimer);
    badge._hideTimer = setTimeout(() => { badge.style.display = 'none'; }, 3000);
  }
}

// ============================================================
// ROOM LIFECYCLE
// ============================================================

// ============================================================
// PRESENCE — re-registers the user on every Firebase reconnect
// ============================================================

function setupPresence() {
  if (presenceListenerUnsubscribe) {
    presenceListenerUnsubscribe();
    presenceListenerUnsubscribe = null;
  }
  const connectedRef = ref(db, '.info/connected');
  presenceListenerUnsubscribe = onValue(connectedRef, async (snap) => {
    if (snap.val() !== true) return;
    // Re-register on every (re)connection so the user always appears in the list
    const userRef = ref(db, `rooms/${roomId}/users/${userId}`);
    try {
      onDisconnect(userRef).remove();
      await set(userRef, username);
    } catch (e) {
      console.warn('Presence re-register failed:', e);
    }
  });
}

async function joinRoom() {
  const roomRef = ref(db, `rooms/${roomId}`);
  try {
    const snap = await get(roomRef);
    if (snap.exists()) {
      const data = snap.val();
      const users = data.users || {};
      const limit = data.maxUsers || MAX_USERS_PER_ROOM;
      if (Object.keys(users).length >= limit && !users[userId]) {
        showNotification(`Room is full (max ${limit} viewers)`, 'error');
        setTimeout(() => window.location.href = 'index.html', 2000);
        return;
      }
    }
  } catch {}

  const userRef = ref(db, `rooms/${roomId}/users/${userId}`);
  try {
    await set(userRef, username);
    onDisconnect(userRef).remove();

    const snap = await get(ref(db, `rooms/${roomId}`));
    if (snap.exists()) {
      const data = snap.val();
      const users = data.users || {};
      if (data.host === userId || Object.keys(users).length === 1) {
        isHost = true;
        await update(ref(db, `rooms/${roomId}`), { host: userId });
      }
    }
  } catch (err) {
    console.error('Join error:', err);
    showNotification('Error joining room', 'error');
  }
}

function listenToRoom() {
  // Clean up any existing listener first
  if (roomListenerUnsubscribe) {
    roomListenerUnsubscribe();
    roomListenerUnsubscribe = null;
  }

  const roomRef = ref(db, `rooms/${roomId}`);
  roomListenerUnsubscribe = onValue(roomRef, async snap => {
    if (!snap.exists()) {
      showNotification('Room was closed', 'error');
      setTimeout(() => window.location.href = 'index.html', 1500);
      return;
    }

    const data = snap.val();
    lastRoomData = data;
    const users = data.users || {};
    userCount = Object.keys(users).length;
    const wasHost = isHost;
    isHost = data.host === userId;
    currentHostId = data.host;

    // Apply accent color from RTDB
    if (data.accentColor && data.accentColor !== currentAccentColor) {
      currentAccentColor = data.accentColor;
      applyAccentColor(data.accentColor);
      // Update swatch selection
      document.querySelectorAll('.hcp-swatch').forEach(s => {
        s.classList.toggle('active', s.title === data.accentColor);
      });
    }

    // Host status changed
    if (wasHost !== isHost) updateHostUI();

    isRoomLocked = data.locked || false;
    const lockBtn = document.getElementById('lockBtnText');
    const lockBtnEl = document.getElementById('lockRoomBtn');
    if (lockBtn) lockBtn.textContent = isRoomLocked ? 'Unlock Room' : 'Lock Room';
    if (lockBtnEl) lockBtnEl.classList.toggle('locked', isRoomLocked);

    cachedUsers = users;
    updateUserList(users, data.host);

    // Live count
    const vtc = document.getElementById('viewerTabCount');
    if (vtc) vtc.textContent = userCount > 0 ? ` (${userCount})` : '';
    updateHCPMemberCount();

    // ── MovieBox: handle currentMovieId sync ───────────────────��─
    // Each client resolves the stream URL locally from the Netlify function
    // so the actual streaming link never travels through Firebase (IP-lock safe).
    //
    // Race-condition guard: Firebase `onValue` can invoke this async callback
    // concurrently (presence updates, chat, playback ticks arrive mid-fetch).
    // We use a monotonic version token so only the most-recent selection's
    // async result is committed; every earlier in-flight load is discarded.
    if (data.currentMovieId && data.currentMovieId !== currentMovieId) {
      const requestedId   = data.currentMovieId;
      const myVersion     = ++_movieLoadVersion; // grab before any await

      // Auto-retry stream fetch — Render may be cold-starting (~30s).
      // Each attempt waits 5s before retrying; give up after 4 tries.
      let streamUrl = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (_movieLoadVersion !== myVersion) break; // newer selection arrived
        if (attempt > 0) {
          showNotification(`MovieBox: server waking up, retry ${attempt}/3…`, 'info');
          await new Promise(r => setTimeout(r, 5000));
        }
        if (_movieLoadVersion !== myVersion) break;
        streamUrl = await loadMovieBoxStream(requestedId);
        if (streamUrl) break;
      }

      // If a newer selection arrived while we were fetching, discard this result.
      if (_movieLoadVersion !== myVersion) { /* stale — newer version won */ }
      else if (streamUrl) {
        currentMovieId  = requestedId; // commit only after successful, current fetch
        currentVideoUrl = streamUrl;
        if (!isHost) pendingInitialSync = data;
        await loadSharedContent(streamUrl);
      }
    } else if (!data.currentMovieId && currentMovieId) {
      // Host cleared the MovieBox selection — allow videoUrl to take over again.
      // Bump version so any in-flight fetch for the old ID is discarded.
      ++_movieLoadVersion;
      currentMovieId = null;
    }

    // Load new video if changed (compare ignoring lang/sub params so guest
    // language preferences don't trigger unnecessary reloads)
    // Skip this block when a MovieBox title just loaded (currentMovieId branch above handled it).
    if (!data.currentMovieId && data.videoUrl && !_videoUrlMatches(data.videoUrl, currentVideoUrl)) {
      currentVideoUrl = data.videoUrl;
      // Store snapshot so loadedmetadata / onReady can apply the seek
      // the moment the player is actually ready — prevents guests from
      // starting at 0 when the video takes time to load metadata.
      if (!isHost) pendingInitialSync = data;
      await loadSharedContent(data.videoUrl);
    }

    // Sync playback — guests only, and only after video has loaded.
    // (For brand-new joiners the real seek happens in loadedmetadata /
    //  onReady via pendingInitialSync; this call handles ongoing updates.)
    if (!isHost) {
      applyVideoSync(data);
    }
  });
}

// ============================================================
// USER LIST
// ============================================================

function updateUserList(users, hostId) {
  const userListEl = document.getElementById('userList');
  const userCountEl = document.getElementById('userCount');
  if (!userListEl) return;

  if (userCountEl) userCountEl.textContent = Object.keys(users).length;
  userListEl.innerHTML = '';

  Object.entries(users).forEach(([uid, name]) => {
    const isUserHost = uid === hostId;
    const li = document.createElement('li');
    li.className = `user-item${isUserHost ? ' is-host-user' : ''}`;
    const initial = name.charAt(0).toUpperCase();
    const color = isUserHost ? null : getUserColor(name);
    li.innerHTML = `
      <div class="user-avatar${isUserHost ? ' host-avatar' : ''}" style="background:${isUserHost ? 'linear-gradient(135deg,#FFD700,#FF8C00)' : color};">${initial}</div>
      <span class="user-name${isUserHost ? ' host-user-name' : ''}"${color ? ` style="color:${color}"` : ''}>${escapeHtml(name)}</span>
      ${isUserHost ? '<span class="user-host-tag">HOST</span>' : ''}
    `;
    userListEl.appendChild(li);
  });
}

// ============================================================
// CHAT
// ============================================================

function listenToChat() {
  // Clean up any existing listener
  if (chatListenerUnsubscribe) {
    chatListenerUnsubscribe();
    chatListenerUnsubscribe = null;
  }

  const chatRef = ref(db, `rooms/${roomId}/chat`);
  let firstLoad = true;
  let prevCount = 0;

  chatListenerUnsubscribe = onValue(chatRef, snap => {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    chatMessages.innerHTML = '';

    if (!snap.exists()) { firstLoad = false; return; }
    const messages = Object.entries(snap.val()).sort((a,b) => a[1].timestamp - b[1].timestamp);
    const newCount = messages.length;

    messages.forEach(([, msg]) => {
      const isFromHost = msg.senderId === currentHostId;
      if (msg.type === 'audio') addAudioMessage(msg.user, msg.audioUrl, msg.timestamp, isFromHost);
      else addChatMessage(msg.user, msg.text, msg.timestamp, isFromHost);
    });

    // Unread badge — only when chat panel not active on mobile
    if (!firstLoad && newCount > prevCount) {
      const chatPanel = document.getElementById('panelChat');
      const isChatVisible = chatPanel && (chatPanel.classList.contains('active') || window.innerWidth >= 768);
      if (!isChatVisible) {
        window._unreadCount = (window._unreadCount || 0) + (newCount - prevCount);
        const badge = document.getElementById('unreadBadge');
        if (badge) { badge.style.display = 'flex'; badge.textContent = window._unreadCount; }
      }
    }
    prevCount = newCount;
    firstLoad = false;

    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
}

function addChatMessage(user, text, timestamp, isFromHost = false) {
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages || !text) return;
  const div = document.createElement('div');
  div.className = 'chat-message';
  const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const color = isFromHost ? null : getUserColor(user);
  div.innerHTML = `
    <div class="message-header">
      <span class="message-user${isFromHost ? ' host-msg-user' : ''}"${color ? ` style="color:${color}"` : ''}>${escapeHtml(user)}</span>
      ${isFromHost ? '<span class="message-host-badge">HOST</span>' : ''}
      <span class="message-time">${time}</span>
    </div>
    <div class="message-text">${escapeHtml(text)}</div>
  `;
  chatMessages.appendChild(div);
}

function addAudioMessage(user, audioUrl, timestamp, isFromHost = false) {
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages) return;
  const div = document.createElement('div');
  div.className = 'chat-message audio-message';
  const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const audioId = 'aud_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const color = isFromHost ? null : getUserColor(user);
  div.innerHTML = `
    <div class="message-header">
      <span class="message-user${isFromHost ? ' host-msg-user' : ''}"${color ? ` style="color:${color}"` : ''}>${escapeHtml(user)}</span>
      ${isFromHost ? '<span class="message-host-badge">HOST</span>' : ''}
      <span class="message-time">${time}</span>
    </div>
    <div class="mini-audio-player">
      <audio id="${audioId}" src="${audioUrl}" preload="none" crossorigin="anonymous"></audio>
      <button class="audio-play-btn" data-audio="${audioId}">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <div class="audio-wave"><span></span><span></span><span></span><span></span><span></span></div>
      <span class="audio-duration">Voice</span>
      <div class="audio-progress"><div class="audio-progress-bar"></div></div>
    </div>
  `;
  chatMessages.appendChild(div);

  const playBtn = div.querySelector('.audio-play-btn');
  const audio = div.querySelector(`#${audioId}`);
  const wave = div.querySelector('.audio-wave');
  const progress = div.querySelector('.audio-progress-bar');

  audio.volume = audioSettings.volume / 100;
  audio.muted = isVideoMuted;
  playBtn.addEventListener('click', () => {
    if (audio.paused) {
      document.querySelectorAll('.mini-audio-player audio').forEach(a => { if (a !== audio && !a.paused) { a.pause(); a.currentTime = 0; } });
      connectMediaToAudioContext(audio);
      audio.play().then(() => {
        playBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
        wave.classList.add('playing');
      }).catch(() => showNotification('Could not play audio', 'error'));
    } else {
      audio.pause();
      playBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
      wave.classList.remove('playing');
    }
  });
  audio.addEventListener('timeupdate', () => { if (audio.duration) progress.style.width = (audio.currentTime / audio.duration * 100) + '%'; });
  audio.addEventListener('ended', () => {
    playBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    wave.classList.remove('playing');
    progress.style.width = '0%';
  });
}

async function sendChatMessage() {
  const chatInput = document.getElementById('chatInput');
  const text = chatInput?.value.trim();
  if (!text) return;
  try {
    await push(ref(db, `rooms/${roomId}/chat`), { user: username, senderId: userId, text, timestamp: Date.now() });
    if (chatInput) chatInput.value = '';
  } catch { showNotification('Failed to send', 'error'); }
}

async function sendAudioMessage(audioUrl) {
  try {
    await push(ref(db, `rooms/${roomId}/chat`), { user: username, senderId: userId, type: 'audio', audioUrl, timestamp: Date.now() });
    showNotification('Voice note sent!', 'success');
  } catch { showNotification('Failed to send voice note', 'error'); }
}

// ============================================================
// UTILS
// ============================================================

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function formatTime(s) {
  if (isNaN(s) || !isFinite(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function updateTimeDisplay() {
  const el = document.getElementById('timeDisplay');
  if (el && videoPlayer) el.textContent = formatTime(videoPlayer.currentTime);
}

let notifTimer = null;
function showNotification(msg, type = 'info') {
  const n = document.getElementById('notification');
  if (!n) return;
  if (notifTimer) clearTimeout(notifTimer);
  n.textContent = msg;
  n.className = `notification ${type}`;
  n.classList.add('show');
  notifTimer = setTimeout(() => n.classList.remove('show'), 2800);
}

// ============================================================
// YOUTUBE TIME UPDATER
// ============================================================

function startYouTubeTimeUpdater() {
  setInterval(() => {
    if (!youtubePlayer || !ytReady || typeof youtubePlayer.getCurrentTime !== 'function') return;
    const t = youtubePlayer.getCurrentTime();
    const seekSlider = document.getElementById('seekSlider');
    const timeDisplay = document.getElementById('timeDisplay');
    if (!isSeeking && seekSlider) seekSlider.value = Math.floor(t);
    if (timeDisplay) timeDisplay.textContent = formatTime(t);
    lastKnownCurrentTime = t;
  }, 500);
}

// ============================================================
// EMBED (Drive / OTT / iframe) TIME UPDATER
// ============================================================

let _embedTimeInterval = null;

function startEmbedTimeUpdater() {
  if (_embedTimeInterval) return; // already running
  _embedTimeInterval = setInterval(() => {
    if (videoPlayer || youtubePlayer) return; // native player took over
    const t = embedPlayStartTime
      ? embedCurrentOffset + (Date.now() - embedPlayStartTime) / 1000
      : embedCurrentOffset;
    const seekSlider = document.getElementById('seekSlider');
    const timeDisplay = document.getElementById('timeDisplay');
    if (!isSeeking && seekSlider) seekSlider.value = Math.floor(t);
    if (timeDisplay) timeDisplay.textContent = formatTime(t);
    lastKnownCurrentTime = t;
  }, 500);
}

function stopEmbedTimeUpdater() {
  if (_embedTimeInterval) { clearInterval(_embedTimeInterval); _embedTimeInterval = null; }
}

// ============================================================
// LEAVE ROOM
// ============================================================

async function handleLeave() {
  // Clean up Firebase listeners before leaving
  if (roomListenerUnsubscribe) { roomListenerUnsubscribe(); roomListenerUnsubscribe = null; }
  if (chatListenerUnsubscribe) { chatListenerUnsubscribe(); chatListenerUnsubscribe = null; }
  if (presenceListenerUnsubscribe) { presenceListenerUnsubscribe(); presenceListenerUnsubscribe = null; }
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
  clearDriveSubtitleOverlay();

  try {
    await remove(ref(db, `rooms/${roomId}/users/${userId}`));
    const snap = await get(ref(db, `rooms/${roomId}`));
    if (snap.exists()) {
      const data = snap.val();
      const remaining = Object.keys(data.users || {}).filter(id => id !== userId);
      if (remaining.length === 0) await remove(ref(db, `rooms/${roomId}`));
      else if (isHost) await update(ref(db, `rooms/${roomId}`), { host: remaining[0] });
    }
  } catch {}
}

// ============================================================
// AUDIO RECORDING & UPLOAD
// ============================================================

async function uploadAudio(audioData) {
  const statusEl = document.getElementById('recordingStatus');
  if (!audioData?.size) { showNotification('No audio data', 'error'); return; }
  if (audioData.size > 15 * 1024 * 1024) { showNotification('Audio too large (max 15MB)', 'error'); return; }
  if (statusEl) { statusEl.textContent = 'Processing…'; statusEl.className = 'recording-status'; }

  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = async e => {
      const base64 = e.target.result;
      if (!base64 || base64.length > 20000000) { showNotification('Audio too large', 'error'); if (statusEl) statusEl.textContent = ''; resolve(); return; }
      if (statusEl) statusEl.textContent = 'Sending…';
      await sendAudioMessage(base64);
      document.getElementById('voiceModal')?.classList.remove('active');
      if (statusEl) statusEl.textContent = '';
      resolve();
    };
    reader.onerror = () => { showNotification('Failed to process audio', 'error'); if (statusEl) statusEl.textContent = ''; resolve(); };
    reader.readAsDataURL(audioData);
  });
}

// ============================================================
// BACKGROUND PLAYBACK
// ============================================================

function keepAudioContextAlive() {
  if (!audioContext) return;
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }
  // Silent-oscillator pulse: keeps iOS/Android audio session from closing
  // when the app is backgrounded. The gain is 0 so it is inaudible.
  if (audioContext.state === 'running') {
    try {
      const g = audioContext.createGain();
      g.gain.value = 0;
      g.connect(audioContext.destination);
      const osc = audioContext.createOscillator();
      osc.connect(g);
      osc.start();
      osc.stop(audioContext.currentTime + 0.001);
    } catch {}
  }
}

function forceBackgroundPlayback() {
  if (isManuallyPaused) return;
  // Resume AudioContext first — must be alive before video can produce sound
  keepAudioContextAlive();
  if (videoPlayer && lastKnownPlayingState && videoPlayer.paused && !userInitiatedPause) {
    videoPlayer.play().catch(() => {
      // Brief muted-play trick to unblock autoplay policy, then restore audio
      const prevMuted = videoPlayer.muted;
      videoPlayer.muted = true;
      videoPlayer.play().catch(() => {}).then(() => {
        setTimeout(() => { videoPlayer.muted = prevMuted; }, 300);
      });
    });
  }
  if (youtubePlayer && ytReady && lastKnownPlayingState && !userInitiatedPause) {
    const s = youtubePlayer.getPlayerState();
    if (s === YT.PlayerState.PAUSED || s === -1) youtubePlayer.playVideo();
  }
  if (lastKnownPlayingState && !userInitiatedPause) { attemptIframeResume(); attemptMusicEmbedResume(); }
}

function startBackgroundPlaybackMonitor() {
  if (backgroundPlaybackInterval || isManuallyPaused) return;
  backgroundPlaybackInterval = setInterval(() => {
    if (document.hidden && lastKnownPlayingState && !userInitiatedPause && !isManuallyPaused) forceBackgroundPlayback();
  }, 1000);
}

function stopBackgroundPlaybackMonitor() {
  if (backgroundPlaybackInterval) { clearInterval(backgroundPlaybackInterval); backgroundPlaybackInterval = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Record state before going background
    if (videoPlayer && !videoPlayer.paused) {
      wasPlayingBeforeHidden = true;
      lastKnownPlayingState = true;
      lastKnownCurrentTime = videoPlayer.currentTime;
    } else if (youtubePlayer && ytReady && youtubePlayer.getPlayerState() === YT.PlayerState.PLAYING) {
      wasPlayingBeforeHidden = true;
      lastKnownPlayingState = true;
    } else if (currentMusicEmbed || document.getElementById('vimeoPlayer') || document.getElementById('dailymotionPlayer')) {
      wasPlayingBeforeHidden = true;
      lastKnownPlayingState = true;
    }
    if (lastKnownPlayingState && !isManuallyPaused) {
      // Start silent audio FIRST so Chrome keeps the audio session alive
      // before any video pause event fires and tries to fight it.
      startSilentAudio();
      startBackgroundPlaybackMonitor();
      setTimeout(forceBackgroundPlayback, 100);
    }
    keepAudioContextAlive();
  } else {
    // Returning to foreground
    stopSilentAudio(); // main video has audio again — no longer need the keepalive
    stopBackgroundPlaybackMonitor();
    if ((wasPlayingBeforeHidden || lastKnownPlayingState) && !isManuallyPaused) {
      setTimeout(async () => {
        // Fetch fresh room state and resync
        if (!isHost) {
          try {
            const snap = await get(ref(db, `rooms/${roomId}`));
            if (snap.exists()) {
              applyVideoSync(snap.val());
            }
          } catch {}
        }
        // Resume playback if needed
        if (videoPlayer?.paused && !userInitiatedPause && !isManuallyPaused) {
          videoPlayer.play().catch(() => { videoPlayer.muted = true; videoPlayer.play().catch(() => {}); });
        }
        if (youtubePlayer && ytReady && youtubePlayer.getPlayerState() !== YT.PlayerState.PLAYING && !userInitiatedPause && !isManuallyPaused) {
          youtubePlayer.playVideo();
        }
        if (currentMusicEmbed && !isManuallyPaused) attemptMusicEmbedResume();
        if (!isManuallyPaused) attemptIframeResume();
      }, 100);
      wasPlayingBeforeHidden = false;
    }
  }
});

window.addEventListener('blur', () => {
  if (videoPlayer && !videoPlayer.paused) { lastKnownPlayingState = true; lastKnownCurrentTime = videoPlayer.currentTime; }
  if (lastKnownPlayingState && !userInitiatedPause && !isManuallyPaused) startBackgroundPlaybackMonitor();
});
window.addEventListener('focus', () => {
  stopBackgroundPlaybackMonitor();
  if (lastKnownPlayingState && !isManuallyPaused) setTimeout(forceBackgroundPlayback, 50);
});

// Chrome Page Lifecycle API — handles aggressive tab-freeze on Android & low-memory desktop.
// 'freeze' fires just before the page is frozen (stricter than visibilitychange).
document.addEventListener('freeze', () => {
  if (lastKnownPlayingState && !isManuallyPaused) {
    startSilentAudio();
    startBackgroundPlaybackMonitor();
  }
  keepAudioContextAlive();
}, { capture: true });

// 'resume' fires when a frozen page is brought back to life.
document.addEventListener('resume', () => {
  stopSilentAudio();
  stopBackgroundPlaybackMonitor();
  if ((wasPlayingBeforeHidden || lastKnownPlayingState) && !isManuallyPaused) {
    setTimeout(forceBackgroundPlayback, 50);
  }
}, { capture: true });

// Keep AudioContext alive — fast polling so tab/app-switch suspension
// is caught within a second rather than the old 10-second window.
setInterval(() => {
  if (!audioContext || isManuallyPaused) return;
  if (audioContext.state === 'suspended' && lastKnownPlayingState) {
    audioContext.resume().catch(() => {});
  }
}, 800);

// ============================================================
// MEDIA SESSION API
// ============================================================

function initMediaSession() {
  if (mediaSessionInitialized || !('mediaSession' in navigator)) return;
  try {
    // Build artwork list — prefer canvas PNG (iOS requires PNG/JPEG, not SVG)
    const artworkSrc = _getMediaArtworkPng();
    const artwork = artworkSrc
      ? [{ src: artworkSrc, sizes: '512x512', type: 'image/png' }]
      : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Wotchly — Watch Together',
      artist: 'Wotchly',
      album: 'Watch Party',
      artwork
    });
    // Only host controls playback via media session buttons
    navigator.mediaSession.setActionHandler('play', () => {
      if (!isHost) return;
      isManuallyPaused = false;
      if (videoPlayer) videoPlayer.play().catch(() => {});
      if (youtubePlayer && ytReady) youtubePlayer.playVideo();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      if (!isHost) return;
      isManuallyPaused = true;
      if (videoPlayer) videoPlayer.pause();
      if (youtubePlayer && ytReady) youtubePlayer.pauseVideo();
    });
    navigator.mediaSession.setActionHandler('seekbackward', d => {
      if (!isHost) return;
      const t = d.seekOffset || 10;
      if (videoPlayer) { videoPlayer.currentTime = Math.max(0, videoPlayer.currentTime - t); updateFirebaseState(videoPlayer.paused ? 'paused' : 'playing', videoPlayer.currentTime); }
      else if (youtubePlayer && ytReady) { const nt = Math.max(0, youtubePlayer.getCurrentTime() - t); youtubePlayer.seekTo(nt, true); updateFirebaseState('playing', nt); }
    });
    navigator.mediaSession.setActionHandler('seekforward', d => {
      if (!isHost) return;
      const t = d.seekOffset || 10;
      if (videoPlayer) { videoPlayer.currentTime = Math.min(videoPlayer.duration, videoPlayer.currentTime + t); updateFirebaseState(videoPlayer.paused ? 'paused' : 'playing', videoPlayer.currentTime); }
      else if (youtubePlayer && ytReady) { const nt = youtubePlayer.getCurrentTime() + t; youtubePlayer.seekTo(nt, true); updateFirebaseState('playing', nt); }
    });
    mediaSessionInitialized = true;
  } catch {}
}

function updateMediaSessionPlaybackState(state) {
  if ('mediaSession' in navigator) try { navigator.mediaSession.playbackState = state; } catch {}
}

const origPlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function() {
  const r = origPlay.apply(this, arguments);
  initMediaSession();
  updateMediaSessionPlaybackState('playing');
  return r;
};

// ============================================================
// KEYBOARD / VISUAL VIEWPORT HANDLING (PWA)
// ============================================================

function initViewportHandler() {
  if (!window.visualViewport) return;

  // Only apply keyboard-open logic on touch devices (mobile/tablet)
  const isTouchDevice = () => navigator.maxTouchPoints > 0;

  // Capture a stable baseline once the page is settled (not screen.height,
  // which is the physical display and mismatches windowed/desktop browsers)
  let baselineVH = window.visualViewport.height;
  let inputFocused = false;

  // Track whether any text input / textarea has focus
  document.addEventListener('focusin', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      inputFocused = true;
      // Refresh baseline just before keyboard might open
      // (take max of current and stored so we don't shrink baseline)
      baselineVH = Math.max(baselineVH, window.visualViewport.height);
    }
  }, true);
  document.addEventListener('focusout', () => {
    inputFocused = false;
    document.body.classList.remove('keyboard-open');
    document.documentElement.style.removeProperty('--vvh');
  }, true);

  window.visualViewport.addEventListener('resize', () => {
    const vh = window.visualViewport.height;

    // Only fire on touch devices while an input is focused, and only when
    // the viewport shrank by >120px relative to the stable baseline
    const isKeyboardVisible =
      isTouchDevice() &&
      inputFocused &&
      (baselineVH - vh) > 120;

    document.documentElement.style.setProperty('--vvh', vh + 'px');
    document.body.classList.toggle('keyboard-open', isKeyboardVisible);

    if (isKeyboardVisible) {
      const chatMessages = document.getElementById('chatMessages');
      if (chatMessages) setTimeout(() => { chatMessages.scrollTop = chatMessages.scrollHeight; }, 50);
    }

    // Update baseline when viewport grows back (keyboard closed)
    if (vh > baselineVH) baselineVH = vh;
  });
}

// ============================================================
// LANDSCAPE / FULLSCREEN DETECTION
// ============================================================

function initLandscapeHandler() {
  // Match the CSS: orientation:landscape AND max-width:1024px (mobile/tablet only)
  const mq = window.matchMedia('(orientation: landscape) and (max-width: 1024px)');

  function onOrientationChange() {
    const isLandscape = mq.matches;
    document.body.classList.toggle('landscape-mode', isLandscape);

    // Always activate chat panel so the input bar is immediately visible
    if (isLandscape) {
      const chatPanel = document.getElementById('panelChat');
      const usersPanel = document.getElementById('panelViewers');
      if (chatPanel) {
        if (usersPanel) usersPanel.classList.remove('active');
        chatPanel.classList.add('active');
      }
    }
  }

  mq.addEventListener('change', onOrientationChange);
  window.addEventListener('orientationchange', () => { setTimeout(onOrientationChange, 100); });
  window.addEventListener('resize', onOrientationChange);
  onOrientationChange();
}

// ============================================================
// ROOM INIT (called after gate)
// ============================================================

function initRoom() {
  applyTheme(localStorage.getItem('wotchly_theme') || 'dark');

  const rcd = document.getElementById('roomCodeDisplay');
  if (rcd) rcd.textContent = roomId;

  // --- DOM refs ---
  const videoContainer = document.getElementById('videoContainer');
  const seekSlider = document.getElementById('seekSlider');
  const playBtn = document.getElementById('playBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const seekBackBtn = document.getElementById('seekBackBtn');
  const seekFwdBtn = document.getElementById('seekFwdBtn');
  const videoUrlBtn = document.getElementById('videoUrlBtn');
  const videoModal = document.getElementById('videoModal');
  const closeVideoModal = document.getElementById('closeVideoModal');
  const videoUrlInput = document.getElementById('videoUrlInput');
  const loadVideoBtn = document.getElementById('loadVideoBtn');
  const voiceModal = document.getElementById('voiceModal');
  const voiceBtn = document.getElementById('voiceBtn');
  const closeVoiceModal = document.getElementById('closeVoiceModal');
  const recordBtn = document.getElementById('recordBtn');
  const uploadAudioBtn = document.getElementById('uploadAudioBtn');
  const audioFileInput = document.getElementById('audioFileInput');
  const settingsModal = document.getElementById('settingsModal');
  const settingsBtn = document.getElementById('settingsBtn');
  const closeSettingsModal = document.getElementById('closeSettingsModal');
  const copyCodeBtn = document.getElementById('copyCodeBtn');
  const shareBtn = document.getElementById('shareBtn');
  const leaveBtn = document.getElementById('leaveBtn');
  const sendChatBtn = document.getElementById('sendChatBtn');
  const chatInput = document.getElementById('chatInput');
  const changeNameBtn = document.getElementById('changeNameBtn');
  const displayNameInput = document.getElementById('displayNameInput');
  const muteNotifBtn = document.getElementById('muteNotifBtn');
  let isMutedNotif = false;
  const leaveRoomBtn = document.getElementById('leaveRoomBtn');
  const lockRoomBtn = document.getElementById('lockRoomBtn');
  const clearChatBtn = document.getElementById('clearChatBtn');
  const placeholderMediaBtn = document.getElementById('placeholderMediaBtn');

  // --- Theme toggle ---
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'light' ? 'dark' : 'light';
      localStorage.setItem('wotchly_theme', next);
      applyTheme(next);
    });
  }

  // --- Video Modal (host only) ---
  if (videoUrlBtn) videoUrlBtn.addEventListener('click', () => { videoModal?.classList.add('active'); videoUrlInput?.focus(); });
  if (placeholderMediaBtn) placeholderMediaBtn.addEventListener('click', () => { videoModal?.classList.add('active'); videoUrlInput?.focus(); });
  if (closeVideoModal) closeVideoModal.addEventListener('click', () => videoModal?.classList.remove('active'));
  if (videoModal) videoModal.addEventListener('click', e => { if (e.target === videoModal) videoModal.classList.remove('active'); });

  // --- Load Video (host only) ---
  if (loadVideoBtn) {
    loadVideoBtn.addEventListener('click', async () => {
      if (!isHost) return;
      const url = videoUrlInput?.value.trim();
      if (!url) { showNotification('Enter a URL', 'error'); return; }
      videoModal?.classList.remove('active');
      await loadSharedContent(url);
      await updateFirebaseState('paused', 0, url);
    });
  }
  if (videoUrlInput) videoUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadVideoBtn?.click(); });

  // --- Playback Controls (host only) ---
  if (playBtn) {
    playBtn.addEventListener('click', async () => {
      if (!isHost) return;
      isManuallyPaused = false;
      userInitiatedPause = false;
      if (videoPlayer) {
        try {
          await videoPlayer.play();
          await updateFirebaseState('playing', videoPlayer.currentTime);
        } catch { showNotification('Tap the video to enable playback', 'info'); }
      }
      if (youtubePlayer && ytReady) {
        youtubePlayer.playVideo();
        await updateFirebaseState('playing', youtubePlayer.getCurrentTime());
      }
      // Iframe embed fallback (Drive, vidsrc, OTT embeds)
      if (!videoPlayer && !youtubePlayer) {
        embedPlayStartTime = Date.now();
        sendIframeCommand('play');
        await updateFirebaseState('playing', embedCurrentOffset);
      }
      // Start periodic sync interval
      if (!syncInterval) {
        syncInterval = setInterval(() => {
          if (!isHost) { clearInterval(syncInterval); syncInterval = null; return; }
          if (videoPlayer && !videoPlayer.paused) updateFirebaseState('playing', videoPlayer.currentTime);
          if (youtubePlayer && ytReady && youtubePlayer.getPlayerState() === YT.PlayerState.PLAYING) {
            updateFirebaseState('playing', youtubePlayer.getCurrentTime());
          }
          // For iframes: report live position without mutating the base offset
          // (base offset accumulates only on pause/seek; elapsed is additive here)
          if (!videoPlayer && !youtubePlayer && embedPlayStartTime) {
            const livePos = embedCurrentOffset + (Date.now() - embedPlayStartTime) / 1000;
            updateFirebaseState('playing', livePos);
          }
        }, SYNC_INTERVAL_MS);
      }
    });
  }

  if (pauseBtn) {
    pauseBtn.addEventListener('click', async () => {
      if (!isHost) return;
      userInitiatedPause = true;
      isManuallyPaused = true;
      lastKnownPlayingState = false;
      stopBackgroundPlaybackMonitor();
      if (videoPlayer) { videoPlayer.pause(); await updateFirebaseState('paused', videoPlayer.currentTime); }
      if (youtubePlayer && ytReady) { youtubePlayer.pauseVideo(); await updateFirebaseState('paused', youtubePlayer.getCurrentTime()); }
      // Iframe embed fallback
      if (!videoPlayer && !youtubePlayer) {
        if (embedPlayStartTime) {
          embedCurrentOffset += (Date.now() - embedPlayStartTime) / 1000;
          embedPlayStartTime = null;
        }
        sendIframeCommand('pause');
        await updateFirebaseState('paused', embedCurrentOffset);
      }
      if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
      setTimeout(() => { userInitiatedPause = false; }, 100);
    });
  }

  // Seek backward 10s
  if (seekBackBtn) {
    seekBackBtn.addEventListener('click', async () => {
      if (!isHost) return;
      const t = 10;
      if (videoPlayer) { videoPlayer.currentTime = Math.max(0, videoPlayer.currentTime - t); await updateFirebaseState(videoPlayer.paused ? 'paused' : 'playing', videoPlayer.currentTime); }
      if (youtubePlayer && ytReady) { const nt = Math.max(0, youtubePlayer.getCurrentTime() - t); youtubePlayer.seekTo(nt, true); await updateFirebaseState('playing', nt); }
      // Iframe embed fallback
      if (!videoPlayer && !youtubePlayer) {
        if (embedPlayStartTime) embedCurrentOffset += (Date.now() - embedPlayStartTime) / 1000;
        embedCurrentOffset = Math.max(0, embedCurrentOffset - t);
        if (embedPlayStartTime) embedPlayStartTime = Date.now();
        sendIframeCommand('seek', embedCurrentOffset);
        await updateFirebaseState('playing', embedCurrentOffset);
      }
    });
  }

  // Seek forward 10s
  if (seekFwdBtn) {
    seekFwdBtn.addEventListener('click', async () => {
      if (!isHost) return;
      const t = 10;
      if (videoPlayer) { const nt = Math.min(videoPlayer.duration || Infinity, videoPlayer.currentTime + t); videoPlayer.currentTime = nt; await updateFirebaseState(videoPlayer.paused ? 'paused' : 'playing', nt); }
      if (youtubePlayer && ytReady) { const nt = youtubePlayer.getCurrentTime() + t; youtubePlayer.seekTo(nt, true); await updateFirebaseState('playing', nt); }
      // Iframe embed fallback
      if (!videoPlayer && !youtubePlayer) {
        if (embedPlayStartTime) embedCurrentOffset += (Date.now() - embedPlayStartTime) / 1000;
        embedCurrentOffset += t;
        if (embedPlayStartTime) embedPlayStartTime = Date.now();
        sendIframeCommand('seek', embedCurrentOffset);
        await updateFirebaseState('playing', embedCurrentOffset);
      }
    });
  }

  // Seek slider
  if (seekSlider) {
    seekSlider.addEventListener('input', () => { isSeeking = true; });
    seekSlider.addEventListener('change', async () => {
      if (!isHost) { isSeeking = false; return; }
      const t = parseFloat(seekSlider.value);
      if (videoPlayer) { videoPlayer.currentTime = t; await updateFirebaseState(videoPlayer.paused ? 'paused' : 'playing', t); }
      if (youtubePlayer && ytReady) { youtubePlayer.seekTo(t, true); const s = youtubePlayer.getPlayerState(); await updateFirebaseState(s === YT.PlayerState.PLAYING ? 'playing' : 'paused', t); }
      // Iframe embed seek — sync position to all guests
      if (!videoPlayer && !youtubePlayer) {
        if (embedPlayStartTime) embedCurrentOffset += (Date.now() - embedPlayStartTime) / 1000;
        embedCurrentOffset = t;
        if (embedPlayStartTime) embedPlayStartTime = Date.now();
        sendIframeCommand('seek', t);
        await updateFirebaseState(embedPlayStartTime ? 'playing' : 'paused', t);
      }
      isSeeking = false;
    });
  }

  // --- Mute button ---
  initMuteButton();

  // --- Landscape button ---
  const landscapeBtn = document.getElementById('landscapeBtn');
  if (landscapeBtn) {
    const iconLandscape = landscapeBtn.querySelector('.icon-landscape');
    const iconPortrait  = landscapeBtn.querySelector('.icon-portrait');
    let isLocked = false;

    const updateLandscapeIcon = () => {
      if (iconLandscape) iconLandscape.style.display = isLocked ? 'none' : '';
      if (iconPortrait)  iconPortrait.style.display  = isLocked ? ''     : 'none';
      landscapeBtn.title = isLocked ? 'Exit Landscape' : 'Landscape Mode';
    };

    landscapeBtn.addEventListener('click', async () => {
      if (!isLocked) {
        isLocked = true;
        updateLandscapeIcon();

        let usedOrientationLock = false;

        // Primary: fullscreen + orientation lock (Android Chrome standard approach)
        try {
          const el = document.documentElement;
          if (el.requestFullscreen) {
            await el.requestFullscreen({ navigationUI: 'hide' });
          } else if (el.webkitRequestFullscreen) {
            el.webkitRequestFullscreen();
            await new Promise(r => setTimeout(r, 350));
          }
          if (screen.orientation?.lock) {
            await screen.orientation.lock('landscape');
            usedOrientationLock = true;
          }
        } catch (e) {
          // Fullscreen or orientation lock not supported/permitted
        }

        // Fallback: CSS rotation (works on all browsers without fullscreen)
        if (!usedOrientationLock) {
          document.body.classList.add('force-landscape');
        }
      } else {
        // Exit landscape
        isLocked = false;
        updateLandscapeIcon();
        try { screen.orientation?.unlock(); } catch (e) {}
        try {
          const exit = document.exitFullscreen || document.webkitExitFullscreen;
          if (exit) exit.call(document);
        } catch (e) {}
        document.body.classList.remove('force-landscape', 'landscape-mode');
      }
    });

    // Auto-handle physical rotation while landscape is locked
    window.addEventListener('orientationchange', () => {
      setTimeout(() => {
        if (!isLocked) return;
        const isNowLandscape = window.innerWidth > window.innerHeight;
        if (isNowLandscape) {
          // Device rotated naturally — drop CSS rotation, keep landscape-mode
          document.body.classList.remove('force-landscape');
          document.body.classList.add('landscape-mode');
        } else {
          // Rotated back to portrait — re-enable CSS rotation
          document.body.classList.remove('landscape-mode');
          document.body.classList.add('force-landscape');
        }
      }, 200);
    });
  }

  // --- Chat ---
  if (sendChatBtn) sendChatBtn.addEventListener('click', sendChatMessage);
  if (chatInput) chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } });

  // --- Voice Modal ---
  if (voiceBtn) voiceBtn.addEventListener('click', () => voiceModal?.classList.add('active'));
  if (closeVoiceModal) closeVoiceModal.addEventListener('click', () => voiceModal?.classList.remove('active'));
  if (voiceModal) voiceModal.addEventListener('click', e => { if (e.target === voiceModal) voiceModal.classList.remove('active'); });

  if (recordBtn) {
    recordBtn.addEventListener('click', async () => {
      const statusEl = document.getElementById('recordingStatus');
      if (!isRecording) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          let mime = 'audio/webm';
          if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus';
          else if (MediaRecorder.isTypeSupported('audio/mp4')) mime = 'audio/mp4';
          else if (MediaRecorder.isTypeSupported('audio/ogg')) mime = 'audio/ogg';
          mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
          audioChunks = [];
          mediaRecorder.ondataavailable = e => { if (e.data?.size > 0) audioChunks.push(e.data); };
          mediaRecorder.onstop = async () => {
            stream.getTracks().forEach(t => t.stop());
            if (!audioChunks.length) { showNotification('No audio recorded', 'error'); if (statusEl) statusEl.textContent = ''; return; }
            await uploadAudio(new Blob(audioChunks, { type: mime }));
          };
          mediaRecorder.start(100);
          isRecording = true;
          recordBtn.classList.add('recording');
          voiceBtn?.classList.add('recording');
          if (statusEl) { statusEl.textContent = '● Recording…'; statusEl.className = 'recording-status active'; }
        } catch { showNotification('Microphone access denied', 'error'); }
      } else {
        if (mediaRecorder?.state !== 'inactive') mediaRecorder.stop();
        isRecording = false;
        recordBtn.classList.remove('recording');
        voiceBtn?.classList.remove('recording');
        if (statusEl) { statusEl.textContent = 'Processing…'; statusEl.className = 'recording-status'; }
      }
    });
  }

  if (uploadAudioBtn) uploadAudioBtn.addEventListener('click', () => audioFileInput?.click());
  if (audioFileInput) {
    audioFileInput.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (file) { await uploadAudio(file); audioFileInput.value = ''; }
    });
  }

  // --- Settings Modal ---
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      const hs = document.getElementById('hostSettings');
      const nhm = document.getElementById('nonHostMessage');
      if (hs) hs.style.display = isHost ? 'block' : 'none';
      if (nhm) nhm.style.display = isHost ? 'none' : 'flex';
      if (displayNameInput) displayNameInput.value = username;
      updateKickUserList();
      initializeAudioSettings();
      settingsModal?.classList.add('active');
    });
  }
  if (closeSettingsModal) closeSettingsModal.addEventListener('click', () => settingsModal?.classList.remove('active'));
  if (settingsModal) settingsModal.addEventListener('click', e => { if (e.target === settingsModal) settingsModal.classList.remove('active'); });

  // --- Copy / Share ---
  if (copyCodeBtn) {
    copyCodeBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(roomId).then(() => showNotification('Room code copied!', 'success')).catch(() => showNotification('Failed to copy', 'error'));
    });
  }
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      const shareUrl = `${window.location.origin}/room.html?room=${roomId}`;
      if (navigator.share) {
        navigator.share({ title: 'Join my Wotchly room', text: `Watch together! Room code: ${roomId}`, url: shareUrl }).catch(() => {});
      } else {
        navigator.clipboard.writeText(shareUrl).then(() => showNotification('Link copied!', 'success')).catch(() => showNotification('Copy failed', 'error'));
      }
    });
  }

  // --- Leave ---
  if (leaveBtn) leaveBtn.addEventListener('click', async () => { await handleLeave(); window.location.href = 'index.html'; });

  // --- Settings actions ---
  if (changeNameBtn) {
    changeNameBtn.addEventListener('click', async () => {
      const newName = displayNameInput?.value.trim();
      if (!newName || newName === username) return;
      try {
        await set(ref(db, `rooms/${roomId}/users/${userId}`), newName);
        localStorage.setItem('wotchly_username', newName);
        username = newName;
        // Update HCP host name if we're host
        const hcpHostName = document.getElementById('hcpHostName');
        if (isHost && hcpHostName) hcpHostName.textContent = username;
        showNotification('Name updated!', 'success');
        settingsModal?.classList.remove('active');
      } catch { showNotification('Failed to update name', 'error'); }
    });
  }

  if (muteNotifBtn) {
    muteNotifBtn.addEventListener('click', () => {
      isMutedNotif = !isMutedNotif;
      muteNotifBtn.classList.toggle('active', isMutedNotif);
      const muteNotifText = document.getElementById('muteNotifText');
      if (muteNotifText) muteNotifText.textContent = isMutedNotif ? 'Unmute Notifications' : 'Mute Notifications';
      showNotification(isMutedNotif ? 'Notifications muted' : 'Notifications enabled', 'info');
    });
  }

  if (leaveRoomBtn) leaveRoomBtn.addEventListener('click', async () => { settingsModal?.classList.remove('active'); await handleLeave(); window.location.href = 'index.html'; });

  if (lockRoomBtn) {
    lockRoomBtn.addEventListener('click', async () => {
      if (!isHost) return;
      isRoomLocked = !isRoomLocked;
      await update(ref(db, `rooms/${roomId}`), { locked: isRoomLocked });
      showNotification(isRoomLocked ? 'Room locked' : 'Room unlocked', 'success');
    });
  }

  if (clearChatBtn) {
    clearChatBtn.addEventListener('click', async () => {
      if (!isHost) return;
      try { await remove(ref(db, `rooms/${roomId}/chat`)); showNotification('Chat cleared', 'success'); } catch { showNotification('Failed to clear chat', 'error'); }
    });
  }

  // --- Quality selector ---
  const qualityBtn = document.getElementById('qualityBtn');
  const qualityDropdown = document.getElementById('qualityDropdown');
  const currentQualityDisplay = document.getElementById('currentQuality');
  if (qualityBtn && qualityDropdown) {
    qualityBtn.addEventListener('click', e => { if (!isHost) return; e.stopPropagation(); qualityDropdown.classList.toggle('active'); });
    document.addEventListener('click', () => qualityDropdown.classList.remove('active'));
    qualityDropdown.querySelectorAll('.quality-option').forEach(opt => {
      opt.addEventListener('click', e => {
        e.stopPropagation();
        const q = opt.dataset.quality;
        currentQuality = q;
        qualityDropdown.querySelectorAll('.quality-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        if (currentQualityDisplay) currentQualityDisplay.textContent = q === 'auto' ? 'Auto' : q + 'p';
        if (youtubePlayer && ytReady && typeof youtubePlayer.setPlaybackQuality === 'function') {
          const ytQ = { '1080':'hd1080','720':'hd720','480':'large','360':'medium','240':'small' }[q] || 'default';
          youtubePlayer.setPlaybackQuality(ytQ);
        }
        showNotification('Quality: ' + (q === 'auto' ? 'Auto' : q + 'p'), 'success');
        qualityDropdown.classList.remove('active');
      });
    });
  }

  // --- Close Room (Host only) ---
  const closeRoomBtn = document.getElementById('closeRoomBtn');
  if (closeRoomBtn) {
    closeRoomBtn.addEventListener('click', async () => {
      if (!isHost) return;
      const confirmed = window.confirm('Close room permanently? This will delete ALL room data and disconnect everyone.');
      if (!confirmed) return;
      try {
        if (roomListenerUnsubscribe) { roomListenerUnsubscribe(); roomListenerUnsubscribe = null; }
        if (chatListenerUnsubscribe) { chatListenerUnsubscribe(); chatListenerUnsubscribe = null; }
        await remove(ref(db, `rooms/${roomId}`));
      } catch (err) {
        console.error(err);
        showNotification('Failed to close room', 'error');
      }
    });
  }

  // --- Audio context on first interaction ---
  document.addEventListener('click', () => {
    if (!audioContextInitialized) { initAudioContext(); applyEqualizerToAudio(); }
  }, { once: true });

  // --- Init host control panel ---
  initHostControlPanel();

  // --- Init language / audio track selector ---
  initLangSelector();

  // --- Init viewport/landscape handlers ---
  initViewportHandler();
  initLandscapeHandler();

  // --- Stream Engine (OTT embed + Anime/Crunchyroll) ---
  initStreamEngine();

  // --- MovieBox Discovery UI ---
  initMovieBoxUI();

  // --- Start room ---
  joinRoom().then(() => {
    updateHostUI();
    listenToRoom();
    listenToChat();
    setupPresence();
  });
}

// ============================================================
// KICK USER LIST
// ============================================================

function updateKickUserList() {
  const list = document.getElementById('kickUserList');
  if (!list) return;
  list.innerHTML = '';
  Object.entries(cachedUsers).forEach(([uid, name]) => {
    if (uid === userId) return;
    const item = document.createElement('div');
    item.className = 'kick-user-item';
    item.innerHTML = `
      <div class="kick-user-info">
        <div class="kick-user-avatar">${name.charAt(0).toUpperCase()}</div>
        <span class="kick-user-name">${escapeHtml(name)}</span>
      </div>
      <div class="kick-user-actions">
        <button class="transfer-btn" data-uid="${uid}">Transfer</button>
        <button class="kick-btn" data-uid="${uid}">Kick</button>
      </div>
    `;
    list.appendChild(item);
  });
  list.querySelectorAll('.kick-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await remove(ref(db, `rooms/${roomId}/users/${btn.dataset.uid}`)); showNotification('User kicked', 'success'); updateKickUserList(); } catch { showNotification('Failed to kick', 'error'); }
    });
  });
  list.querySelectorAll('.transfer-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await update(ref(db, `rooms/${roomId}`), { host: btn.dataset.uid }); showNotification('Host transferred', 'success'); document.getElementById('settingsModal')?.classList.remove('active'); } catch { showNotification('Failed to transfer', 'error'); }
    });
  });
}

// ============================================================
// THEME
// ============================================================

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.body.setAttribute('data-theme', theme);
  const tt = document.getElementById('themeToggle');
  if (tt) tt.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
  const ttg = document.getElementById('themeToggleGate');
  if (ttg) ttg.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
}

// ============================================================
// STREAM ENGINE  (OTT Embed + Anime/Crunchyroll via Consumet)
// ============================================================

// Helper: read the provider dropdown and return the selected provider's base URL
function _getSelectedProviderBase() {
  const sel = document.getElementById('seProvider');
  if (!sel) return DEFAULT_PROVIDER.base;
  const found = EMBED_PROVIDERS.find(p => p.id === sel.value);
  return found ? found.base : DEFAULT_PROVIDER.base;
}

function initStreamEngine() {
  // ── Tab switcher ────────────────────────────────────────────
  const seTabs = document.querySelectorAll('.se-tab');
  seTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      seTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.se-panel').forEach(p => (p.style.display = 'none'));
      const target = document.getElementById(tab.dataset.seTab);
      if (target) target.style.display = 'block';
    });
  });

  // ── IMDb / TMDB → vidsrc embed ──────────────────────────────
  const seContentType = document.getElementById('seContentType');
  const seTvRow = document.getElementById('seTvRow');
  if (seContentType && seTvRow) {
    seContentType.addEventListener('change', () => {
      seTvRow.style.display = seContentType.value === 'tv' ? 'flex' : 'none';
    });
  }

  const seLoadOttBtn = document.getElementById('seLoadOttBtn');
  const seOttWarning = document.getElementById('seOttWarning');

  // Live: detect OTT URL vs IMDb ID and show warning
  const seOttInput = document.getElementById('seOttInput');
  if (seOttInput && seOttWarning) {
    seOttInput.addEventListener('input', () => {
      const val = seOttInput.value.trim();
      const platformDomains = ['hotstar.com','jiohotstar.com','netflix.com','primevideo.com','amazon.com','disneyplus.com'];
      const isPlatformUrl = val.startsWith('http') && platformDomains.some(d => val.includes(d));
      const isImdbId = /^tt\d{5,10}$/i.test(val);
      const isTmdbId = /^\d{4,8}$/.test(val);
      if (isPlatformUrl && !isImdbId) {
        const title = extractTitleFromOttUrl(val);
        const titleHint = title ? ` (detected: "<strong>${title}</strong>")` : '';
        seOttWarning.innerHTML = `⚠️ Platform URL detected${titleHint}. For reliable playback, find this title's IMDb ID on <a href="https://www.imdb.com/find?q=${encodeURIComponent(title||val)}" target="_blank" rel="noopener">imdb.com</a> and paste the <code>tt…</code> ID instead.`;
        seOttWarning.style.display = 'block';
      } else if (isImdbId || isTmdbId || val === '') {
        seOttWarning.style.display = 'none';
      }
    });
  }

  if (seLoadOttBtn) {
    seLoadOttBtn.addEventListener('click', async () => {
      if (!isHost) { showNotification('Only the host can load media', 'error'); return; }
      const input = seOttInput?.value.trim();
      if (!input) { showNotification('Enter an IMDb ID or OTT URL', 'error'); return; }

      const type = seContentType?.value || 'movie';
      const season  = type === 'tv' ? parseInt(document.getElementById('seSeason')?.value  || '1', 10) : null;
      const episode = type === 'tv' ? parseInt(document.getElementById('seEpisode')?.value || '1', 10) : null;
      const providerBase = _getSelectedProviderBase();

      const resolved = resolveOttEmbed(input, type, season, episode, providerBase);
      if (!resolved) {
        showNotification('Could not resolve — try an IMDb ID (tt…) or direct Netflix/Prime/Hotstar URL', 'error');
        return;
      }

      // Apply selected audio + subtitle language to the embed URL before loading
      const ottFinalUrl = (currentEmbedLang || currentEmbedSubLang)
        ? _applyEmbedParams(resolved.url, currentEmbedLang, currentEmbedSubLang) : resolved.url;

      seLoadOttBtn.textContent = 'Loading…';
      seLoadOttBtn.disabled = true;
      try {
        document.getElementById('videoModal')?.classList.remove('active');
        await loadSharedContent(ottFinalUrl);
        await updateFirebaseState('paused', 0, ottFinalUrl);
        showNotification(`Stream loading — ${resolved.note}`, 'success');
      } finally {
        seLoadOttBtn.textContent = 'Load Embed';
        seLoadOttBtn.disabled = false;
      }
    });
  }

  // ── Anime search via Consumet ───────────────────────────────
  let selectedAnimeId = null;
  let selectedAnimeTitle = '';

  const seAnimeSearchBtn = document.getElementById('seAnimeSearchBtn');
  const seAnimeQuery    = document.getElementById('seAnimeQuery');
  const seAnimeResults  = document.getElementById('seAnimeResults');
  const seAnimeEpSection = document.getElementById('seAnimeEpSection');
  const seAnimeEpGrid   = document.getElementById('seAnimeEpGrid');
  const seAnimeBackBtn  = document.getElementById('seAnimeBackBtn');
  const seAnimeEpTitle  = document.getElementById('seAnimeEpTitle');

  async function runAnimeSearch() {
    if (!isHost) { showNotification('Only the host can load media', 'error'); return; }
    const q = seAnimeQuery?.value.trim();
    if (!q) { showNotification('Enter an anime title', 'error'); return; }

    if (seAnimeSearchBtn) { seAnimeSearchBtn.textContent = '…'; seAnimeSearchBtn.disabled = true; }
    if (seAnimeResults) seAnimeResults.innerHTML = '<p class="se-searching">Searching…</p>';
    if (seAnimeEpSection) seAnimeEpSection.style.display = 'none';

    try {
      const results = await searchAnime(q);
      if (!seAnimeResults) return;
      if (!results.length) {
        seAnimeResults.innerHTML = '<p class="se-no-results">No results found. Try a different title.</p>';
        return;
      }
      seAnimeResults.innerHTML = '';
      results.slice(0, 8).forEach(r => {
        const item = document.createElement('div');
        item.className = 'se-anime-result';
        const badge = r.isMovie
          ? '<span class="se-anime-badge se-anime-badge-movie">MOVIE</span>'
          : (r.totalEpisodes ? `<span class="se-anime-badge">${r.totalEpisodes} eps</span>` : '');
        item.innerHTML = `
          ${r.image ? `<img src="${escapeHtml(r.image)}" alt="" class="se-anime-thumb" loading="lazy">` : '<div class="se-anime-thumb se-anime-thumb-placeholder"></div>'}
          <div class="se-anime-info">
            <span class="se-anime-name">${escapeHtml(r.title)}</span>
            ${badge}
          </div>
        `;
        item.style.cursor = 'pointer';
        item.addEventListener('click', () => {
          if (r.isMovie) {
            streamAnimeMovie(r.idMal, r.id, r.title);
          } else {
            loadAnimeEpisodes(r.id, r.title);
          }
        });
        seAnimeResults.appendChild(item);
      });
    } catch {
      if (seAnimeResults) seAnimeResults.innerHTML = '<p class="se-no-results">Search failed — check your connection.</p>';
    } finally {
      if (seAnimeSearchBtn) { seAnimeSearchBtn.textContent = 'Search'; seAnimeSearchBtn.disabled = false; }
    }
  }

  async function loadAnimeEpisodes(animeId, title) {
    selectedAnimeId = animeId;
    selectedAnimeTitle = title;
    if (seAnimeResults) seAnimeResults.innerHTML = '';
    if (seAnimeEpSection) seAnimeEpSection.style.display = 'block';
    if (seAnimeEpTitle) seAnimeEpTitle.textContent = title;
    if (seAnimeEpGrid) seAnimeEpGrid.innerHTML = '<p class="se-searching">Loading episodes…</p>';

    try {
      const eps = await getAnimeEpisodes(animeId);
      if (!seAnimeEpGrid) return;
      if (!eps.length) {
        seAnimeEpGrid.innerHTML = '<p class="se-no-results">No episodes found.</p>';
        return;
      }
      seAnimeEpGrid.innerHTML = '';
      eps.forEach(ep => {
        const btn = document.createElement('button');
        btn.className = 'se-ep-btn';
        btn.textContent = `Ep ${ep.number}`;
        btn.addEventListener('click', () => streamAnimeEpisode(ep.id, ep.number));
        seAnimeEpGrid.appendChild(btn);
      });
    } catch {
      if (seAnimeEpGrid) seAnimeEpGrid.innerHTML = '<p class="se-no-results">Failed to load episodes.</p>';
    }
  }

  async function streamAnimeEpisode(episodeId, epNumber) {
    if (!isHost) { showNotification('Only the host can load media', 'error'); return; }
    showNotification(`Loading Ep ${epNumber}…`, 'info');

    // Reset provider index so retry cycles start from current provider
    _currentProviderIdx = EMBED_PROVIDERS.findIndex(p => p.base === _getSelectedProviderBase());
    if (_currentProviderIdx < 0) _currentProviderIdx = 0;

    const providerBase = _getSelectedProviderBase();
    const embedUrl = await getAnimeStreamUrl(episodeId, providerBase);
    if (!embedUrl) {
      showNotification('Could not find this episode — try a different provider or search by IMDb ID in the OTT tab', 'error');
      return;
    }

    // Default to Hindi dub if no explicit preference set
    const langToApply = currentEmbedLang || 'hi';
    if (!localStorage.getItem('wotchly_embed_lang')) {
      currentEmbedLang = 'hi';
      localStorage.setItem('wotchly_embed_lang', 'hi');
    }

    const finalUrl = _applyEmbedParams(embedUrl, langToApply, currentEmbedSubLang);

    // Track for retry
    _lastAnimeLoad = { type: 'episode', episodeId, epNumber, title: selectedAnimeTitle };

    document.getElementById('videoModal')?.classList.remove('active');
    // Route through loadSharedContent so detectVideoType('embed') picks it up cleanly
    await loadSharedContent(finalUrl);
    await updateFirebaseState('paused', 0, finalUrl);
    const langName = langToApply === 'hi' ? 'Hindi dub' : langToApply.toUpperCase();
    showNotification(`${escapeHtml(selectedAnimeTitle)} Ep ${epNumber} — stream loading (${langName})`, 'success');
    // Show retry bar so host can switch provider if Hindi isn't available
    setTimeout(_showDubRetryBar, 1200);
  }

  // Anime movies (format: MOVIE) — look up real IMDb/TMDB ID via ani.zip, then embed
  async function streamAnimeMovie(malId, anilistId, title) {
    if (!isHost) { showNotification('Only the host can load media', 'error'); return; }
    showNotification(`Looking up "${title}"…`, 'info');

    // Reset provider index for retry cycling
    _currentProviderIdx = EMBED_PROVIDERS.findIndex(p => p.base === _getSelectedProviderBase());
    if (_currentProviderIdx < 0) _currentProviderIdx = 0;

    const providerBase = _getSelectedProviderBase();
    const result = await resolveAnimeMovieUrl(malId, anilistId, providerBase);

    if (!result) {
      showNotification('Could not resolve movie — try a different provider', 'error');
      return;
    }

    if (result.warn) {
      showNotification(`⚠️ ${result.warn} Trying anyway…`, 'info');
    }

    // Default to Hindi dub if no explicit preference set
    const langToApply = currentEmbedLang || 'hi';
    if (!localStorage.getItem('wotchly_embed_lang')) {
      currentEmbedLang = 'hi';
      localStorage.setItem('wotchly_embed_lang', 'hi');
    }

    const finalUrl = _applyEmbedParams(result.url, langToApply, currentEmbedSubLang);

    // Track for retry
    _lastAnimeLoad = { type: 'movie', malId, anilistId, title };

    document.getElementById('videoModal')?.classList.remove('active');
    await loadSharedContent(finalUrl);
    await updateFirebaseState('paused', 0, finalUrl);

    const langName = langToApply === 'hi' ? 'Hindi dub' : langToApply.toUpperCase();
    const idNote = result.warn ? ' (try next provider if blank)' : '';
    showNotification(`${escapeHtml(title)} — movie loading (${langName})${idNote}`, result.warn ? 'info' : 'success');
    // Show retry bar so host can switch provider if Hindi isn't available
    setTimeout(_showDubRetryBar, 1200);
  }

  if (seAnimeSearchBtn) seAnimeSearchBtn.addEventListener('click', runAnimeSearch);
  if (seAnimeQuery) seAnimeQuery.addEventListener('keydown', e => { if (e.key === 'Enter') runAnimeSearch(); });
  if (seAnimeBackBtn) {
    seAnimeBackBtn.addEventListener('click', () => {
      if (seAnimeEpSection) seAnimeEpSection.style.display = 'none';
      if (seAnimeResults) seAnimeResults.innerHTML = '';
      if (seAnimeQuery) seAnimeQuery.value = '';
    });
  }
}

// ============================================================
// BOOT
// ============================================================

// Register global postMessage listener for browser-mode video auto-expand
window.addEventListener('message', _onIframeMessage);

initUsernameGate();
