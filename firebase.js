// ════════════════════════════════════════════════════════
// firebase.js — Firebase-oppsett, konstanter og delt tilstand
// ════════════════════════════════════════════════════════

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore, collection, doc, addDoc, updateDoc,
  getDoc, getDocs, query, where, orderBy, limit,
  onSnapshot, serverTimestamp, writeBatch, runTransaction,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ════════════════════════════════════════════════════════
// FIREBASE-KONFIGURASJON — bytt til dine verdier
// ════════════════════════════════════════════════════════
const FB_CONFIG = {
  apiKey:            'AIzaSyB_0rxDzHpV2HB6JdHm8SEHoGc8vE2F_rE',
  authDomain:        'pickle-rank-5fbe5.firebaseapp.com',
  projectId:         'pickle-rank-5fbe5',
  storageBucket:     'pickle-rank-5fbe5.firebasestorage.app',
  messagingSenderId: '761601873916',
  appId:             '1:761601873916:web:f3c13d21e809658fd80479',
};

// ════════════════════════════════════════════════════════
// ADMIN-PIN — bytt denne, lagres kun i applikasjonslaget
// ════════════════════════════════════════════════════════
export const ADMIN_PIN = '1234';

// ════════════════════════════════════════════════════════
// KONSTANTER
// ════════════════════════════════════════════════════════
export const SAM = {
  SPILLERE:   'players',
  TRENINGER:  'treninger',
  TS:         'treningSpillere',
  KAMPER:     'kamper',
  RESULTATER: 'resultater',
  HISTORIKK:  'ratingHistorikk',
};

export const STARTRATING = 1000;

export const PARTER = [
  { nr:1, lag1:[0,1], lag2:[2,3] },
  { nr:2, lag1:[0,2], lag2:[1,3] },
  { nr:3, lag1:[0,3], lag2:[1,2] },
];

export const PARTER_5 = [
  { nr:1, lag1:[0,1], lag2:[2,3], hviler:4 },
  { nr:2, lag1:[0,2], lag2:[1,4], hviler:3 },
  { nr:3, lag1:[0,3], lag2:[2,4], hviler:1 },
  { nr:4, lag1:[0,4], lag2:[1,3], hviler:2 },
  { nr:5, lag1:[1,2], lag2:[3,4], hviler:0 },
];

export const PARTER_6_DOBBEL = [
  { nr:1, lag1:[0,1], lag2:[2,3], singel:false },
];

export const PARTER_6_SINGEL = [
  { nr:1, lag1:[0], lag2:[1], singel:true },
];

// ════════════════════════════════════════════════════════
// FIREBASE INIT
// ════════════════════════════════════════════════════════
let db;
try {
  const fbApp = initializeApp(FB_CONFIG);
  db = getFirestore(fbApp);
} catch (e) {
  // visFBFeil importeres ikke her — ui.js håndterer det ved oppstart
  console.error('[Firebase] Kunne ikke koble til:', e?.message ?? e);
}

export { db };

// Re-eksporter alt fra Firestore SDK slik at andre moduler
// kun trenger å importere fra denne filen
export {
  collection, doc, addDoc, updateDoc,
  getDoc, getDocs, query, where, orderBy, limit,
  onSnapshot, serverTimestamp, writeBatch, runTransaction,
};
