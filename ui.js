// ════════════════════════════════════════════════════════
// ui.js — Generelle UI-hjelpere
// Toast-meldinger, Firebase-feilbanner, XSS-escaping,
// navigasjon, sveip, og UI-låsesystem.
// ════════════════════════════════════════════════════════

// Ingen import av app/state.js — app-spesifikk tilstand
// sendes inn som parametere eller registreres via hjelpere.

// ════════════════════════════════════════════════════════
// TOAST + FIREBASE-FEILBANNER
// ════════════════════════════════════════════════════════
let toastTimer = null;

export function visMelding(tekst, type = 'ok') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = tekst;
  t.className   = 'toast' + (type === 'feil' ? ' feil' : type === 'advarsel' ? ' advarsel' : '');
  t.classList.add('vis');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('vis'), 2800);
}

export function visFBFeil(tekst) {
  const banner = document.getElementById('firebase-feil-banner');
  const span   = document.getElementById('firebase-feil-tekst');
  if (banner && span) { span.textContent = tekst; banner.classList.add('vis'); }
  console.error('[Firebase]', tekst);
}

// ════════════════════════════════════════════════════════
// XSS-BESKYTTELSE
// ════════════════════════════════════════════════════════
export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ════════════════════════════════════════════════════════
// NAVIGASJON
// ════════════════════════════════════════════════════════
const SVEIP_FANER = ['hjem', 'baner', 'slutt', 'spillere', 'arkiv'];
let _aktivFane = 'hjem';

function settAktivFane(skjerm) {
  if (SVEIP_FANER.includes(skjerm)) _aktivFane = skjerm;
}

// app.js registrerer sin navigasjonshandler her ved oppstart.
// Kalles av naviger() etter at skjerm-byttet er utført.
let _navigertHandler = null;
export function registrerNavigertHandler(fn) {
  _navigertHandler = fn;
}

export function naviger(skjerm, retning = null) {
  settAktivFane(skjerm);
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active', 'sveip-venstre', 'sveip-hoyre');
  });
  document.querySelectorAll('.nav-knapp').forEach(b => b.classList.remove('aktiv'));

  const navMap = {
    hjem: 'nav-hjem',
    baner: 'nav-baner', slutt: 'nav-slutt',
    spillere: 'nav-spillere', 'global-profil': 'nav-spillere',
    arkiv: 'nav-arkiv', treningsdetalj: 'nav-arkiv',
  };
  const nb = document.getElementById(navMap[skjerm]);
  if (nb) nb.classList.add('aktiv');

  const ingenNav = ['hjem', 'poeng', 'resultat', 'profil', 'global-profil', 'treningsdetalj'];
  document.getElementById('bunn-nav').style.display =
    ingenNav.includes(skjerm) ? 'none' : 'flex';

  const tilbakeBoks = document.getElementById('oppsett-tilbake-boks');
  if (tilbakeBoks) tilbakeBoks.style.display = skjerm === 'oppsett' ? 'flex' : 'none';

  const skjermMap = { 'oppsett-nav': 'oppsett' };
  const sid = 'skjerm-' + (skjermMap[skjerm] ?? skjerm);
  const el  = document.getElementById(sid);
  if (el) {
    if (retning === 'venstre') el.classList.add('sveip-venstre');
    else if (retning === 'hoyre') el.classList.add('sveip-hoyre');
    el.classList.add('active');
  }

  if (_navigertHandler) _navigertHandler(skjerm);
}
window.naviger = naviger;

// ════════════════════════════════════════════════════════
// SVEIP-NAVIGASJON
// ════════════════════════════════════════════════════════
let _sveipStartX = null;
let _sveipStartY = null;

document.addEventListener('touchstart', e => {
  _sveipStartX = e.touches[0].clientX;
  _sveipStartY = e.touches[0].clientY;
}, { passive: true });

document.addEventListener('touchend', e => {
  if (_sveipStartX === null) return;
  const dx = e.changedTouches[0].clientX - _sveipStartX;
  const dy = e.changedTouches[0].clientY - _sveipStartY;
  _sveipStartX = null;
  _sveipStartY = null;

  if (Math.abs(dy) > Math.abs(dx)) return;
  if (Math.abs(dx) < 60) return;
  if (!SVEIP_FANER.includes(_aktivFane)) return;

  const mål = e.target;
  if (mål.tagName === 'INPUT' || mål.tagName === 'TEXTAREA') return;

  const idx = SVEIP_FANER.indexOf(_aktivFane);
  if (dx < 0 && idx < SVEIP_FANER.length - 1) naviger(SVEIP_FANER[idx + 1], 'venstre');
  else if (dx > 0 && idx > 0)                 naviger(SVEIP_FANER[idx - 1], 'hoyre');
}, { passive: true });

// ════════════════════════════════════════════════════════
// UI-LÅS — forhindrer dobbelt-klikk og race conditions
// ════════════════════════════════════════════════════════
const UI_LAS_KNAPPER = ['neste-runde-knapp', 'neste-runde-resultat-knapp'];

export function lasUI(melding = 'Systemet jobber…') {
  UI_LAS_KNAPPER.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = true;
    el._gammelTekst = el.textContent;
    el.textContent = melding;
  });
  const lagreBtn   = document.querySelector('#modal-bekreft .knapp-gronn');
  const avsluttBtn = document.querySelector('#modal-avslutt .knapp-fare');
  if (lagreBtn)   { lagreBtn.disabled   = true; lagreBtn._gammelTekst   = lagreBtn.textContent;   lagreBtn.textContent   = 'Vennligst vent…'; }
  if (avsluttBtn) { avsluttBtn.disabled = true; avsluttBtn._gammelTekst = avsluttBtn.textContent; avsluttBtn.textContent = 'Vennligst vent…'; }
}

export function frigiUI() {
  UI_LAS_KNAPPER.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = false;
    if (el._gammelTekst) { el.textContent = el._gammelTekst; delete el._gammelTekst; }
  });
  const lagreBtn   = document.querySelector('#modal-bekreft .knapp-gronn');
  const avsluttBtn = document.querySelector('#modal-avslutt .knapp-fare');
  if (lagreBtn)   { lagreBtn.disabled   = false; if (lagreBtn._gammelTekst)   { lagreBtn.textContent   = lagreBtn._gammelTekst;   delete lagreBtn._gammelTekst; } }
  if (avsluttBtn) { avsluttBtn.disabled = false; if (avsluttBtn._gammelTekst) { avsluttBtn.textContent = avsluttBtn._gammelTekst; delete avsluttBtn._gammelTekst; } }
}

// Fail-safe: løser lås automatisk etter 10 sekunder om noe krasjer.
// onLaasLos — asynkron callback fra app.js som løser Firestore-låsen.
// Kalles med ingen argumenter; app.js har tilgang til treningId via closure.
let failSafeTimer = null;

export function startFailSafe(onLaasLos) {
  clearTimeout(failSafeTimer);
  failSafeTimer = setTimeout(async () => {
    console.warn('[Lås] Fail-safe utløst — løser lås automatisk');
    if (typeof onLaasLos === 'function') {
      try { await onLaasLos(); }
      catch (e) { console.warn('[Lås] Fail-safe feilet:', e?.message); }
    }
    frigiUI();
  }, 10000);
}

export function stoppFailSafe() {
  clearTimeout(failSafeTimer);
}

// ════════════════════════════════════════════════════════
// BEFOREUNLOAD — advar ved utilsiktet lukking
// app.js kaller denne ved oppstart og sender inn en
// funksjon som returnerer true om det er en aktiv økt.
// ════════════════════════════════════════════════════════
export function registrerBeforeunload(harAktivOkt) {
  window.addEventListener('beforeunload', e => {
    if (harAktivOkt()) { e.preventDefault(); e.returnValue = ''; }
  });
}
