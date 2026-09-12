import { db, ref, set, get, remove, onValue, update } from './firebase.js';

// Access key stored as SHA-256 byte array — no plaintext in source.
// Each number is one byte of the SHA-256 digest of the access code.
const _AK = [197,50,174,34,233,81,28,180,143,60,144,169,239,155,161,3,65,190,83,8,216,117,40,219,254,39,109,50,9,199,56,180];
const SESSION_KEY = 'wotchly_admin_session';

let currentDeleteAction = null;
let roomsListener = null;
let bannedListener = null;

function checkAuth() {
  return sessionStorage.getItem(SESSION_KEY) === 'authenticated';
}

async function authenticate(password) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  const b = new Uint8Array(buf);
  if (b.length === _AK.length && _AK.every((v, i) => b[i] === v)) {
    sessionStorage.setItem(SESSION_KEY, 'authenticated');
    return true;
  }
  return false;
}

function logout() {
  sessionStorage.removeItem(SESSION_KEY);
  showAuthOverlay();
}

function showAuthOverlay() {
  document.getElementById('authOverlay').style.display = 'flex';
  document.getElementById('adminPanel').style.display = 'none';
}

function showAdminPanel() {
  document.getElementById('authOverlay').style.display = 'none';
  document.getElementById('adminPanel').style.display = 'flex';
  initRealtimeListeners();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getDeviceId() {
  let deviceId = localStorage.getItem('wotchly_deviceId');
  if (!deviceId) {
    deviceId = 'dev_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('wotchly_deviceId', deviceId);
  }
  return deviceId;
}

function initRealtimeListeners() {
  const roomsRef = ref(db, 'rooms');
  roomsListener = onValue(roomsRef, (snapshot) => {
    renderRoomsAndUsers(snapshot.val() || {});
  });

  const bannedRef = ref(db, 'banned');
  bannedListener = onValue(bannedRef, (snapshot) => {
    renderBannedList(snapshot.val() || {});
  });
}

function renderRoomsAndUsers(rooms) {
  const roomsList = document.getElementById('roomsList');
  const usersList = document.getElementById('usersList');
  const totalRoomsCount = document.getElementById('totalRoomsCount');
  const totalUsersCount = document.getElementById('totalUsersCount');

  const roomIds = Object.keys(rooms);
  let totalUsers = 0;
  let usersHtml = '';
  let roomsHtml = '';

  roomIds.forEach(roomId => {
    const room = rooms[roomId];
    const users = room.users || {};
    const userIds = Object.keys(users);
    const userCount = userIds.length;
    totalUsers += userCount;

    roomsHtml += `
      <div class="admin-list-item">
        <div class="admin-item-info">
          <span class="admin-item-title">${escapeHtml(roomId)}</span>
          <span class="admin-item-meta">${userCount} user${userCount !== 1 ? 's' : ''} | Host: ${escapeHtml(room.host?.substring(0, 8) || 'N/A')}...</span>
        </div>
        <div class="admin-item-actions">
          <button class="admin-action-btn admin-warn" data-action="closeRoom" data-room="${roomId}">Close</button>
          <button class="admin-action-btn admin-danger" data-action="kickAll" data-room="${roomId}">Kick All</button>
        </div>
      </div>
    `;

    userIds.forEach(uid => {
      const userName = users[uid];
      usersHtml += `
        <div class="admin-list-item">
          <div class="admin-item-info">
            <span class="admin-item-title">${escapeHtml(userName)}</span>
            <span class="admin-item-meta">Room: ${escapeHtml(roomId)} | UID: ${escapeHtml(uid.substring(0, 12))}...</span>
          </div>
          <div class="admin-item-actions">
            <button class="admin-action-btn admin-warn" data-action="kickUser" data-room="${roomId}" data-uid="${uid}">Kick</button>
            <button class="admin-action-btn admin-danger" data-action="banUser" data-room="${roomId}" data-uid="${uid}" data-name="${escapeHtml(userName)}">Ban</button>
          </div>
        </div>
      `;
    });
  });

  roomsList.innerHTML = roomsHtml || '<div class="admin-empty">No active rooms</div>';
  usersList.innerHTML = usersHtml || '<div class="admin-empty">No users online</div>';
  totalRoomsCount.textContent = roomIds.length;
  totalUsersCount.textContent = totalUsers;

  attachRoomActions();
  attachUserActions();
}

function renderBannedList(banned) {
  const bannedList = document.getElementById('bannedList');
  const bannedCount = document.getElementById('bannedCount');

  const bannedIds = Object.keys(banned);
  bannedCount.textContent = bannedIds.length;

  if (bannedIds.length === 0) {
    bannedList.innerHTML = '<div class="admin-empty">No bans</div>';
    return;
  }

  let html = '';
  bannedIds.forEach(banId => {
    const ban = banned[banId];
    const date = new Date(ban.timestamp).toLocaleDateString();
    html += `
      <div class="admin-banned-item">
        <div class="admin-banned-info">
          <span>${escapeHtml(ban.username || 'Unknown')}</span>
          <span class="admin-banned-meta">${escapeHtml(ban.type)} | ${date}</span>
        </div>
        <button class="admin-action-btn admin-success" data-action="unban" data-banid="${banId}">Unban</button>
      </div>
    `;
  });

  bannedList.innerHTML = html;
  attachBanActions();
}

function attachRoomActions() {
  document.querySelectorAll('[data-action="closeRoom"]').forEach(btn => {
    btn.onclick = async () => {
      const roomId = btn.dataset.room;
      try {
        await remove(ref(db, `rooms/${roomId}`));
      } catch (e) {
        console.error('Close room error:', e);
      }
    };
  });

  document.querySelectorAll('[data-action="kickAll"]').forEach(btn => {
    btn.onclick = async () => {
      const roomId = btn.dataset.room;
      try {
        await remove(ref(db, `rooms/${roomId}/users`));
      } catch (e) {
        console.error('Kick all error:', e);
      }
    };
  });
}

function attachUserActions() {
  document.querySelectorAll('[data-action="kickUser"]').forEach(btn => {
    btn.onclick = async () => {
      const roomId = btn.dataset.room;
      const uid = btn.dataset.uid;
      try {
        await remove(ref(db, `rooms/${roomId}/users/${uid}`));
      } catch (e) {
        console.error('Kick user error:', e);
      }
    };
  });

  document.querySelectorAll('[data-action="banUser"]').forEach(btn => {
    btn.onclick = async () => {
      const roomId = btn.dataset.room;
      const uid = btn.dataset.uid;
      const userName = btn.dataset.name;
      try {
        const banId = 'ban_' + Date.now();
        await set(ref(db, `banned/${banId}`), {
          uid: uid,
          username: userName,
          type: 'uid',
          timestamp: Date.now()
        });
        await remove(ref(db, `rooms/${roomId}/users/${uid}`));
      } catch (e) {
        console.error('Ban user error:', e);
      }
    };
  });
}

function attachBanActions() {
  document.querySelectorAll('[data-action="unban"]').forEach(btn => {
    btn.onclick = async () => {
      const banId = btn.dataset.banid;
      try {
        await remove(ref(db, `banned/${banId}`));
      } catch (e) {
        console.error('Unban error:', e);
      }
    };
  });
}

document.getElementById('adminLoginBtn').addEventListener('click', async () => {
  const password = document.getElementById('adminPassword').value;
  const errorEl = document.getElementById('authError');
  const loginBtn = document.getElementById('adminLoginBtn');
  loginBtn.disabled = true;
  
  if (await authenticate(password)) {
    showAdminPanel();
    errorEl.textContent = '';
  } else {
    errorEl.textContent = 'Invalid access code';
    document.getElementById('adminPassword').value = '';
  }
  loginBtn.disabled = false;
});

document.getElementById('adminPassword').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    document.getElementById('adminLoginBtn').click();
  }
});

document.getElementById('adminLogout').addEventListener('click', logout);

document.querySelectorAll('.admin-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab + 'Section').classList.add('active');
  });
});

document.querySelectorAll('.admin-db-action .admin-danger-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentDeleteAction = btn.dataset.action;
    document.getElementById('confirmDialog').style.display = 'block';
    document.getElementById('confirmInput').value = '';
    document.getElementById('confirmInput').focus();
  });
});

document.getElementById('confirmCancel').addEventListener('click', () => {
  document.getElementById('confirmDialog').style.display = 'none';
  currentDeleteAction = null;
});

document.getElementById('confirmDelete').addEventListener('click', async () => {
  const confirmInput = document.getElementById('confirmInput').value.trim();
  
  if (confirmInput !== 'DELETE') {
    return;
  }

  try {
    switch (currentDeleteAction) {
      case 'deleteRooms':
        await remove(ref(db, 'rooms'));
        break;
      case 'deleteChats':
        const roomsSnapshot = await get(ref(db, 'rooms'));
        if (roomsSnapshot.exists()) {
          const rooms = roomsSnapshot.val();
          for (const roomId of Object.keys(rooms)) {
            await remove(ref(db, `rooms/${roomId}/chat`));
          }
        }
        break;
      case 'deletePresence':
        const presenceSnapshot = await get(ref(db, 'rooms'));
        if (presenceSnapshot.exists()) {
          const rooms = presenceSnapshot.val();
          for (const roomId of Object.keys(rooms)) {
            await remove(ref(db, `rooms/${roomId}/users`));
          }
        }
        break;
    }
  } catch (e) {
    console.error('Delete action error:', e);
  }

  document.getElementById('confirmDialog').style.display = 'none';
  currentDeleteAction = null;
});

if (checkAuth()) {
  showAdminPanel();
} else {
  showAuthOverlay();
}

window.addEventListener('beforeunload', () => {
  sessionStorage.removeItem(SESSION_KEY);
});
