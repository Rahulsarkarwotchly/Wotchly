// ============================================================
// Wotchly Sync — Firebase Realtime Database client.
// Rooms, chat and presence sync via Firebase RTDB.
// Same API surface the app uses: ref, set, get, push, update,
// remove, onValue, onDisconnect.
// ============================================================
import { initializeApp } from 'firebase/app';
import {
  getDatabase,
  ref, set, get, push, update, remove, onValue, onDisconnect,
} from 'firebase/database';

const firebaseApp = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
});

export const db = getDatabase(firebaseApp);
export { ref, set, get, push, update, remove, onValue, onDisconnect };
