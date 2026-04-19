import {
  db, SAM, STARTRATING, PARTER, PARTER_5, PARTER_6_DOBBEL, PARTER_6_SINGEL,
  collection, doc, addDoc, updateDoc, getDoc, getDocs,
  query, where, orderBy, limit, onSnapshot, serverTimestamp, writeBatch, runTransaction,
} from './firebase.js';
import { app, erMix } from './state.js';
import {
  getParter, blandArray, beregnPoengForKamp,
  fordelBaner, fordelBanerMix,
  lagMixKampoppsett, oppdaterMixStatistikk, hentMixStatistikk,
  neste6SpillerRunde,
} from './rotasjon.js';
import {
  getNivaaKlasse, getNivaaLabel, getNivaaRatingHTML,
  eloForventet, oppdaterRatingForKamp, beregnEloForOkt, beregnTrend,
} from './rating.js';
import {
  visMelding, visFBFeil, escHtml,
  lasUI, frigiUI, startFailSafe, stoppFailSafe,
  registrerNavigertHandler, registrerBeforeunload,
} from './ui.js';
import {
  krevAdmin as _krevAdminBase, pinInput, bekreftPin, lukkPinModal,
  getErAdmin, setErAdmin, nullstillAdmin, registrerPinGetter,
} from './admin.js';
// ════════════════════════════════════════════════════════
// KLUBB-KONFIGURASJON
// ════════════════════════════════════════════════════════
const KLUBBER = {
  'pickleball-jaeren': { navn: 'Pickleball Jæren', pin: '9436', demo: false },
  'fokus-pickleball':  { navn: 'Fokus Pickleball',  pin: '4350', demo: false },
  'demo':              { navn: 'Demo',               pin: null,   demo: true  },
};

// Aktiv klubb — settes av byttKlubb()
let aktivKlubbId = null;

function getAktivKlubb() {
  return aktivKlubbId ? (KLUBBER[aktivKlubbId] ?? null) : null;
}

// Admin-PIN for aktiv klubb (null = ingen PIN = demo)
function getAdminPin() {
  return getAktivKlubb()?.pin ?? null;
}

// Lokal wrapper — tilføyer demo-modus-flagget til hvert krevAdmin-kall
// slik at alle eksisterende kallsteder ikke trenger å endres.
function krevAdminMedDemo(tittel, tekst, callback) {
  _krevAdminBase(tittel, tekst, callback, !!getAktivKlubb()?.demo);
}
// Overstyr window.krevAdmin slik at inline onclick-attributter også bruker wrapperen
window.krevAdmin = krevAdminMedDemo;

function byttKlubb(klubbId) {
  if (!klubbId || !KLUBBER[klubbId]) {
    aktivKlubbId = null;
    oppdaterKlubbUI();
    return;
  }
  aktivKlubbId = klubbId;
  setErAdmin(KLUBBER[klubbId].demo); // demo-modus: alltid admin
  nullstillSisteDeltakereCache();
  oppdaterKlubbUI();
  // Start opp for valgt klubb
  initEtterKlubbValg();
  visMelding('Klubb valgt: ' + KLUBBER[klubbId].navn);
}
window.byttKlubb = byttKlubb;

function oppdaterKlubbUI() {
  const klubb    = getAktivKlubb();
  const navn     = klubb?.navn ?? '';
  const erDemo   = klubb?.demo ?? false;

  // Oppdater klubbnavn i alle headere
  document.querySelectorAll('[id$="klubbnavn"], .app-name[id="oppsett-klubbnavn"]').forEach(el => {
    el.textContent = navn || 'Pickleball';
  });

  // Vis/skjul demo-info
  const demoInfo = document.getElementById('demo-info');
  if (demoInfo) demoInfo.style.display = erDemo ? 'block' : 'none';

  // Sett riktig verdi i select
  const velger = document.getElementById('klubb-velger');
  if (velger && aktivKlubbId) velger.value = aktivKlubbId;

  // Oppdater app-sub (under klubbnavnet) på oppsett-skjermen
  const appSub = document.querySelector('#skjerm-oppsett .app-sub');
  if (appSub) appSub.textContent = 'Americano' + (erDemo ? ' · Demo' : '');
}

/**
 * Henter gjeldende treningsdokument fra Firestore.
 * @returns {Promise<{id, data}>}
 */
async function hentTrening() {
  if (!app.treningId) throw new Error('Ingen aktiv økt.');
  const snap = await getDoc(doc(db, SAM.TRENINGER, app.treningId));
  if (!snap.exists()) throw new Error('Øktdokument ikke funnet.');
  return { id: snap.id, data: snap.data() };
}

/**
 * Setter lås på treningsdokumentet via transaksjon.
 * Stopper hvis allerede låst, avsluttet, eller runden ikke stemmer.
 * @param {number|null} forventetRunde — hvis satt, sjekkes mot Firestore-runden
 * @returns {Promise<object>} treningsdata
 */
async function lassTrening(forventetRunde = null) {
  let treningsData = null;

  await runTransaction(db, async (tx) => {
    const ref  = doc(db, SAM.TRENINGER, app.treningId);
    const snap = await tx.get(ref);

    if (!snap.exists())              throw new Error('Økt ikke funnet.');
    const data = snap.data();

    if (data.status !== 'aktiv')     throw new Error('Økten er allerede avsluttet.');
    if (data.laast === true)         throw new Error('En annen bruker jobber akkurat nå. Vent litt og prøv igjen.');

    if (forventetRunde !== null && data.gjeldendRunde !== forventetRunde) {
      throw new Error(`Runden har blitt oppdatert av en annen bruker (runde ${data.gjeldendRunde}). Last siden på nytt.`);
    }

    tx.update(ref, { laast: true });
    treningsData = data;
  });

  return treningsData;
}

/**
 * Løser låsen på treningsdokumentet.
 */
async function lossTrening() {
  if (!app.treningId || !db) return;
  try {
    await updateDoc(doc(db, SAM.TRENINGER, app.treningId), { laast: false });
  } catch (e) {
    console.warn('[Lås] Kunne ikke løse lås:', e?.message ?? e);
  }
}

/**
 * Bytter spillmodus basert på brukervalg i oppsett-skjermen.
 * Oppdaterer app.spillModus og justerer UI-elementer deretter.
 * @param {'konkurranse'|'mix'} modus
 */
function settSpillModus(modus) {
  app.spillModus = modus;

  // Oppdater knappestiler
  const btnKonk = document.getElementById('modus-knapp-konkurranse');
  const btnMix  = document.getElementById('modus-knapp-mix');
  if (btnKonk) btnKonk.classList.toggle('modus-aktiv', modus === 'konkurranse');
  if (btnMix)  btnMix.classList.toggle('modus-aktiv',  modus === 'mix');

  // Vis/skjul info-boks for valgt modus
  const infoKonk = document.getElementById('modus-info-konkurranse');
  const infoMix  = document.getElementById('modus-info-mix');
  if (infoKonk) infoKonk.style.display = modus === 'konkurranse' ? 'block' : 'none';
  if (infoMix)  infoMix.style.display  = modus === 'mix'         ? 'block' : 'none';

  // Oppdater spillerliste — viser/skjuler rating basert på modus
  visSpillere();
}
window.settSpillModus = settSpillModus;


// ════════════════════════════════════════════════════════
// HJEMSKJERM
// ════════════════════════════════════════════════════════

/**
 * Oppdaterer status-seksjonen på hjemskjermen basert på app-tilstand.
 * Kalles automatisk via naviger('hjem').
 */
function visHjemStatus() {
  const dot        = document.getElementById('hjem-status-dot');
  const tekst      = document.getElementById('hjem-status-tekst');
  const sub        = document.getElementById('hjem-status-sub');
  const fortsett   = document.getElementById('hjem-fortsett-knapp');
  const startKnapp = document.getElementById('hjem-start-knapp');

  const harOkt = !!app.treningId;

  if (dot) dot.classList.toggle('aktiv', harOkt);

  if (harOkt) {
    // Mix: sosial tone i status-teksten
    if (tekst) tekst.textContent = erMix() ? '🎲 Mix & Match pågår' : '🟢 Økt pågår';
    if (sub)   sub.textContent   = erMix()
      ? `Kamp ${app.runde} av ${app.maksRunder}`
      : `Runde ${app.runde} av ${app.maksRunder}`;
    if (fortsett) fortsett.style.display = 'block';
    if (startKnapp) startKnapp.textContent = 'START NY ØKT';
  } else {
    if (tekst) tekst.textContent = 'Ingen aktiv økt';
    if (sub)   sub.textContent   = '';
    if (fortsett) fortsett.style.display = 'none';
    if (startKnapp) startKnapp.textContent = 'START NY ØKT';
  }
}
window.visHjemStatus = visHjemStatus;

/**
 * Sett logo-bilde på hjemskjermen.
 * Kall denne med filsti etter at logoen er tilgjengelig.
 * Eksempel: settHjemLogo('/logo.png')
 */
function settHjemLogo(src) {
  const img = document.getElementById('hjem-logo-img');
  if (img) img.src = src;
}
window.settHjemLogo = settHjemLogo;

// ════════════════════════════════════════════════════════
// OPPSETT — TRINNVELGERE
// ════════════════════════════════════════════════════════
function juster(key, dir) {
  if (key === 'baner')  app.antallBaner  = Math.max(1, Math.min(7,  app.antallBaner  + dir));
  if (key === 'poeng')  app.poengPerKamp = Math.max(5, Math.min(50, app.poengPerKamp + dir));
  if (key === 'runder') app.maksRunder   = Math.max(1, Math.min(10, app.maksRunder   + dir));
  document.getElementById('verdi-baner').textContent  = app.antallBaner;
  document.getElementById('verdi-poeng').textContent  = app.poengPerKamp;
  document.getElementById('verdi-runder').textContent = app.maksRunder;
  document.getElementById('maks-hint').textContent    = app.poengPerKamp;
  visSpillere(); // visSpillere oppdaterer spiller-info og min-antall dynamisk
}
window.juster = juster;

// ════════════════════════════════════════════════════════
// SPILLERLISTE (Firebase onSnapshot)
// ════════════════════════════════════════════════════════
// Separat referanse til spillerliste-lytteren — skal ALDRI stoppes ved avslutning
let spillerLytterAvmeld = null;

function lyttPaaSpillere() {
  if (!db) return;
  if (!aktivKlubbId) {
    app.spillere = [];
    visSpillere();
    return;
  }
  if (spillerLytterAvmeld) { try { spillerLytterAvmeld(); } catch (_) {} }
  document.getElementById('spiller-laster').style.display = 'flex';
  spillerLytterAvmeld = onSnapshot(
    query(collection(db, SAM.SPILLERE), where('klubbId', '==', aktivKlubbId), orderBy('rating', 'desc')),
    (snap) => {
      document.getElementById('spiller-laster').style.display = 'none';
      app.spillere = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      visSpillere();
      // Åpne siste-deltakere automatisk når spillere er lastet
      if (!_sisteDeltakereApen) {
        _sisteDeltakereApen = true;
        const panel = document.getElementById('siste-deltakere-panel');
        const pil   = document.getElementById('siste-deltakere-pil');
        if (panel) panel.style.display = 'block';
        if (pil)   pil.style.transform = 'rotate(180deg)';
        lastSisteDeltakere();
      }
    },
    (feil) => {
      document.getElementById('spiller-laster').style.display = 'none';
      visFBFeil('Feil ved lasting av spillere: ' + (feil?.message ?? feil));
    }
  );
}


function lagSpillerHTML(s, erAktiv, erVente) {
  const navn   = s.navn ?? 'Ukjent';
  const ini    = navn.split(' ').map(w => w[0] ?? '').join('').slice(0,2).toUpperCase() || '?';
  const rating = typeof s.rating === 'number' ? s.rating : STARTRATING;
  let kl    = 'spiller-element';
  let merke = '';
  if (erAktiv) { kl += ' valgt'; }
  if (erVente) { kl += ' ventende'; merke = '<span class="vl-merke">VL</span>'; }
  const hake = (erAktiv || erVente)
    ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
    : '';

  // Mix: ingen nivåfarger i spillerlisten
  if (!erAktiv && !erVente && !erMix()) kl += ' ' + getNivaaKlasse(rating);

  // Mix: skjul rating-linje under spillernavn
  const ratingLinje = erMix()
    ? ''
    : `<div style="font-family:'DM Mono',monospace;font-size:15px">⭐ ${getNivaaRatingHTML(rating)}</div>`;

  return `<div class="${escHtml(kl)}" data-id="${escHtml(s.id)}" onclick="veksleSpiller('${escHtml(s.id)}')">
    <div class="spiller-avatar">${escHtml(ini)}</div>
    <div style="flex:1">
      <div style="font-size:18px;font-weight:500">${escHtml(navn)}</div>
      ${ratingLinje}
    </div>
    ${merke}
    <div class="spiller-hake">${hake}</div>
  </div>`;
}

// Beregn aktiv/ventende-status basert på valgte spillere
function _beregnSpillerStatus() {
  const er6Format = app.antallBaner === 2 && app.valgtIds.size === 6;
  const min = er6Format ? 6 : app.antallBaner * 4;
  const sorterteValgte = [...app.valgtIds]
    .map(id => (app.spillere ?? []).find(s => s.id === id))
    .filter(Boolean)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  return {
    min, er6Format,
    aktiveIds:   new Set(sorterteValgte.slice(0, min).map(s => s.id)),
    ventendeIds: new Set(sorterteValgte.slice(min).map(s => s.id)),
  };
}

// Oppdater tellere og start-knapp uten å røre listen
function _oppdaterSpillerTellere(min, er6Format) {
  const n = app.valgtIds.size;
  document.getElementById('valgt-antall').textContent  = n;
  document.getElementById('aktive-antall').textContent = Math.min(n, min);
  document.getElementById('vl-antall').textContent     = Math.max(0, n - min);
  document.getElementById('start-knapp').disabled      = n < (er6Format ? 6 : min);
  const spillerInfoEl = document.getElementById('spiller-info');
  if (spillerInfoEl) {
    spillerInfoEl.innerHTML = er6Format
      ? `Nøyaktig <span id="min-antall" style="color:var(--yellow);font-weight:700">6</span> spillere <span style="color:var(--muted)">— 4 dobbel + 2 singel format aktivert</span>`
      : `Minst <span id="min-antall" style="color:var(--yellow);font-weight:700">${min}</span> spillere <span style="color:var(--muted)">— ekstra settes på venteliste</span>`;
  }
}

// Full rebuild — brukes kun ved søk og første lasting

// ════════════════════════════════════════════════════════
// SISTE DELTAKERE — viser de 20 siste unike spillerne
// som har deltatt på trening, sortert alfabetisk
// ════════════════════════════════════════════════════════
let _sisteDeltakereApen = false;
let _sisteDeltakereCache = null; // { ids: Set, hentetMs }
const SISTE_DELTAKERE_TTL_MS = 5 * 60 * 1000; // 5 min cache

async function toggleSisteDeltakere() {
  _sisteDeltakereApen = !_sisteDeltakereApen;

  const panel = document.getElementById('siste-deltakere-panel');
  const pil   = document.getElementById('siste-deltakere-pil');
  if (panel) panel.style.display = _sisteDeltakereApen ? 'block' : 'none';
  if (pil)   pil.style.transform = _sisteDeltakereApen ? 'rotate(180deg)' : '';

  if (_sisteDeltakereApen) {
    // Behold alltid valgte spillere i cachen uavhengig av Firestore-henting
    if (_sisteDeltakereCache && app.valgtIds.size > 0) {
      const merged = [...new Set([...app.valgtIds, ..._sisteDeltakereCache.spillerIds])];
      _sisteDeltakereCache.spillerIds = merged;
    }
    await lastSisteDeltakere();
  }
}
window.toggleSisteDeltakere = toggleSisteDeltakere;

async function lastSisteDeltakere() {
  if (!db || !aktivKlubbId) return;

  // ── Regel: valgte spillere forsvinner ALDRI ──────────────────
  // Bygg alltid listen fra valgtIds + tidligere cache FØR Firestore-kall
  const tidligereCacheIds = _sisteDeltakereCache?.spillerIds ?? [];
  const sikkerListe = [...new Set([...app.valgtIds, ...tidligereCacheIds])];

  // Oppdater cache og vis umiddelbart
  _sisteDeltakereCache = {
    spillerIds: sikkerListe,
    hentetMs:   _sisteDeltakereCache?.hentetMs ?? 0,
  };
  visSisteDeltakere(sikkerListe);

  // ── Hopp over Firestore om cachen er fersk nok ───────────────
  const naa = Date.now();
  if ((naa - (_sisteDeltakereCache.hentetMs ?? 0)) < SISTE_DELTAKERE_TTL_MS) return;

  // ── Hent fra Firestore i bakgrunnen ─────────────────────────
  try {
    const treningSnap = await getDocs(
      query(
        collection(db, SAM.TRENINGER),
        where('klubbId', '==', aktivKlubbId),
        where('status', '==', 'avsluttet'),
        orderBy('avsluttetDato', 'desc'),
        limit(10)
      )
    );

    const sett  = new Set([...app.valgtIds]);
    const unike = [...app.valgtIds];

    // Legg til fra Firestore-treninger
    if (!treningSnap.empty) {
      const treningIds = treningSnap.docs.map(d => d.id);
      const chunks = [];
      for (let i = 0; i < treningIds.length; i += 10) chunks.push(treningIds.slice(i, i + 10));

      for (const chunk of chunks) {
        if (chunk.length === 0) continue;
        const snap = await getDocs(query(collection(db, SAM.TS), where('treningId', 'in', chunk)));
        snap.docs.forEach(d => {
          const id = d.data().spillerId;
          if (id && !sett.has(id) && unike.length < 20) { sett.add(id); unike.push(id); }
        });
      }
    }

    // Legg til fra aktiv økt
    if (app.treningId) {
      try {
        const snap = await getDocs(query(collection(db, SAM.TS), where('treningId', '==', app.treningId)));
        snap.docs.forEach(d => {
          const id = d.data().spillerId;
          if (id && !sett.has(id)) { sett.add(id); unike.push(id); }
        });
      } catch (_) {}
    }

    // Oppdater cache — alltid med valgtIds i front
    const ferdigListe = [...new Set([...app.valgtIds, ...unike])];
    _sisteDeltakereCache = { spillerIds: ferdigListe, hentetMs: Date.now() };
    visSisteDeltakere(ferdigListe);

  } catch (e) {
    console.warn('[SisteDeltakere]', e?.message ?? e);
    // Ved feil: behold det vi allerede viser — ikke overskriv
  }
}

function visSisteDeltakere(spillerIds) {
  const liste = document.getElementById('siste-deltakere-liste');
  if (!liste) return;

  // Finn spillerobjektene fra app.spillere
  // Sorter: uvalgte øverst (alfabetisk), valgte nederst (alfabetisk)
  const { aktiveIds: _aIds, ventendeIds: _vIds } = _beregnSpillerStatus();
  const spillere = spillerIds
    .map(id => (app.spillere ?? []).find(s => s.id === id))
    .filter(Boolean)
    .sort((a, b) => {
      const aValgt = (_aIds.has(a.id) || _vIds.has(a.id)) ? 1 : 0;
      const bValgt = (_aIds.has(b.id) || _vIds.has(b.id)) ? 1 : 0;
      if (aValgt !== bValgt) return aValgt - bValgt;
      return (a.navn ?? '').localeCompare(b.navn ?? '', 'nb');
    });

  if (spillere.length === 0) {
    liste.innerHTML = '<div style="padding:10px 0;font-size:15px;color:var(--muted2);text-align:center">Ingen spillere funnet.</div>';
    return;
  }

  // Del i uvalgte og valgte med separator
  const uvalgte = spillere.filter(s => !_aIds.has(s.id) && !_vIds.has(s.id));
  const valgte  = spillere.filter(s =>  _aIds.has(s.id) ||  _vIds.has(s.id));

  let html = uvalgte.map(s => lagSpillerHTML(s, false, false)).join('');

  if (valgte.length > 0) {
    if (uvalgte.length > 0) {
      html += `<div style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted);padding:10px 0 6px;margin-top:4px;border-top:1px solid var(--border)">Valgte</div>`;
    }
    html += valgte.map(s => lagSpillerHTML(s, _aIds.has(s.id), _vIds.has(s.id))).join('');
  }

  liste.innerHTML = html;
}

// Oppdater siste-deltakere-listen når spillerstatus endres (f.eks. ved toggle)
// Bygger alltid listen på nytt så sorteringen (uvalgte øverst) er korrekt
function oppdaterSisteDeltakereInPlace() {
  if (!_sisteDeltakereApen) return;
  const base = _sisteDeltakereCache?.spillerIds ?? [];
  const merged = [...new Set([...app.valgtIds, ...base])];
  if (merged.length === 0) return;
  visSisteDeltakere(merged);
}

// Nullstill cache når klubb byttes
function nullstillSisteDeltakereCache() {
  _sisteDeltakereCache = null;
  _sisteDeltakereApen  = false;
  const panel = document.getElementById('siste-deltakere-panel');
  const pil   = document.getElementById('siste-deltakere-pil');
  if (panel) panel.style.display = 'none';
  if (pil)   pil.style.transform = '';
}


// Viser søkeresultater direkte i siste-deltakere-panelet
function visSokIPanel(q) {
  const liste = document.getElementById('siste-deltakere-liste');
  if (!liste) return;
  const qLow = (q ?? '').toLowerCase();
  const { aktiveIds, ventendeIds } = _beregnSpillerStatus();

  // Søketreff (uvalgte) + alle allerede valgte spillere
  const treffIds = new Set(
    (app.spillere ?? [])
      .filter(s => (s.navn ?? '').toLowerCase().includes(qLow))
      .map(s => s.id)
  );
  const visIds = new Set([...treffIds, ...aktiveIds, ...ventendeIds]);

  const treff = (app.spillere ?? [])
    .filter(s => visIds.has(s.id))
    .sort((a, b) => {
      // Uvalgte søketreff øverst, valgte nederst
      const aValgt = (aktiveIds.has(a.id) || ventendeIds.has(a.id)) ? 1 : 0;
      const bValgt = (aktiveIds.has(b.id) || ventendeIds.has(b.id)) ? 1 : 0;
      if (aValgt !== bValgt) return aValgt - bValgt;
      return (a.navn ?? '').localeCompare(b.navn ?? '', 'nb');
    });

  // Del i to grupper: søketreff (uvalgte) og valgte
  const sokTreff  = treff.filter(s => !aktiveIds.has(s.id) && !ventendeIds.has(s.id));
  const valgte    = treff.filter(s =>  aktiveIds.has(s.id) ||  ventendeIds.has(s.id));

  // Legg alltid til valgte spillere som ikke er i søketreff
  const allValgte = (app.spillere ?? []).filter(s =>
    (aktiveIds.has(s.id) || ventendeIds.has(s.id)) && !visIds.has(s.id)
  );
  const alleValgte = [...valgte, ...allValgte]
    .sort((a, b) => (a.navn ?? '').localeCompare(b.navn ?? '', 'nb'));

  if (sokTreff.length === 0 && alleValgte.length === 0) {
    liste.innerHTML = '<div style="padding:10px 0;font-size:15px;color:var(--muted2);text-align:center">Ingen treff.</div>';
    return;
  }

  let html = sokTreff.map(s => lagSpillerHTML(s, false, false)).join('');

  if (alleValgte.length > 0) {
    html += `<div style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted);padding:10px 0 6px;margin-top:4px;border-top:1px solid var(--border)">Valgte</div>`;
    html += alleValgte.map(s =>
      lagSpillerHTML(s, aktiveIds.has(s.id), ventendeIds.has(s.id))
    ).join('');
  }

  liste.innerHTML = html;
}

function visSpillere() {
  const q = (document.getElementById('sok-inndata').value ?? '').toLowerCase();
  const { min, er6Format, aktiveIds, ventendeIds } = _beregnSpillerStatus();
  const filtrerte = (app.spillere ?? []).filter(s => (s.navn ?? '').toLowerCase().includes(q));
  document.getElementById('spiller-liste').innerHTML = filtrerte.map(s =>
    lagSpillerHTML(s, aktiveIds.has(s.id), ventendeIds.has(s.id))
  ).join('');
  _oppdaterSpillerTellere(min, er6Format);
}
window.visSpillere = visSpillere;

// In-place oppdatering ved toggle — ingen innerHTML, ingen scroll-hopp
function _oppdaterSpillerListeInPlace() {
  const { min, er6Format, aktiveIds, ventendeIds } = _beregnSpillerStatus();
  document.querySelectorAll('#spiller-liste [data-id]').forEach(el => {
    const sid     = el.dataset.id;
    const erAktiv = aktiveIds.has(sid);
    const erVente = ventendeIds.has(sid);
    const erValgt = erAktiv || erVente;
    const spiller = (app.spillere ?? []).find(s => s.id === sid);
    const rating  = spiller?.rating ?? STARTRATING;
    el.className  = 'spiller-element'
      + (erAktiv ? ' valgt' : '')
      + (erVente ? ' ventende' : '')
      + (!erValgt && !erMix() ? ' ' + getNivaaKlasse(rating) : '');
    const hakeEl = el.querySelector('.spiller-hake');
    if (hakeEl) hakeEl.innerHTML = erValgt
      ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
      : '';
    const eksVL = el.querySelector('.vl-merke');
    if (erVente && !eksVL) {
      const m = document.createElement('span');
      m.className = 'vl-merke'; m.textContent = 'VL';
      el.insertBefore(m, hakeEl);
    } else if (!erVente && eksVL) { eksVL.remove(); }
  });
  _oppdaterSpillerTellere(min, er6Format);
  oppdaterSisteDeltakereInPlace();
}

// Debounce på søkefeltet — kun ved faktisk bruker-input (ikke programmatisk tømming)
let _sokTimer = null;
let _sokBrukerInput = false;
document.getElementById('sok-inndata')?.addEventListener('keydown', () => { _sokBrukerInput = true; });
document.getElementById('sok-inndata')?.addEventListener('input', () => {
  if (!_sokBrukerInput) return;
  _sokBrukerInput = false;
  clearTimeout(_sokTimer);
  _sokTimer = setTimeout(() => {
    const q = document.getElementById('sok-inndata')?.value ?? '';
    if (q.trim()) {
      // Vis søkeresultater i siste-deltakere-panelet
      const panel = document.getElementById('siste-deltakere-panel');
      const pil   = document.getElementById('siste-deltakere-pil');
      if (panel && panel.style.display === 'none') {
        panel.style.display = 'block';
        if (pil) pil.style.transform = 'rotate(180deg)';
        _sisteDeltakereApen = true;
      }
      visSokIPanel(q);
    } else {
      // Søk tømt — gå tilbake til siste deltakere
      oppdaterSisteDeltakereInPlace();
    }
  }, 150);
});

function veksleSpiller(id) {
  if (!id) return;
  if (app.valgtIds.has(id)) {
    app.valgtIds.delete(id);
  } else {
    app.valgtIds.add(id);
  }
  // Tøm søkefeltet alltid og oppdater listen
  clearTimeout(_sokTimer);
  const sok = document.getElementById('sok-inndata');
  if (sok) sok.value = '';
  const spillerListe = document.getElementById('spiller-liste');
  if (spillerListe) spillerListe.style.display = 'none';
  _oppdaterSpillerListeInPlace();
  oppdaterSisteDeltakereInPlace();
  const _st = _beregnSpillerStatus(); _oppdaterSpillerTellere(_st.min, _st.er6Format);
}
window.veksleSpiller = veksleSpiller;

async function leggTilSpiller() {
  if (!db) { visMelding('Firebase ikke tilkoblet.', 'feil'); return; }
  const inp  = document.getElementById('ny-spiller-inndata');
  const navn = (inp.value ?? '').trim();
  if (!navn) { visMelding('Skriv inn et navn først.', 'advarsel'); return; }
  if (navn.length > 50) { visMelding('Navnet er for langt (maks 50 tegn).', 'advarsel'); return; }
  if (app.spillere.some(s => (s.navn ?? '').toLowerCase() === navn.toLowerCase())) {
    visMelding('En deltaker med det navnet finnes allerede!', 'feil');
    return;
  }
  try {
    const ref = await addDoc(collection(db, SAM.SPILLERE), {
      navn, rating: STARTRATING, klubbId: aktivKlubbId, opprettetDato: serverTimestamp(),
    });
    // Legg til lokalt med ein gong sa lista vises riktig for onSnapshot returnerer
    app.spillere.push({ id: ref.id, navn, rating: STARTRATING });
    app.valgtIds.add(ref.id);
    inp.value = '';
    const sok = document.getElementById('sok-inndata');
    if (sok) { sok.value = ''; }
    // Legg til i cache og oppdater siste-deltakere-listen
    if (_sisteDeltakereCache) {
      if (!_sisteDeltakereCache.spillerIds.includes(ref.id)) {
        _sisteDeltakereCache.spillerIds.unshift(ref.id);
      }
      _sisteDeltakereCache.hentetMs = Date.now();
    } else {
      // Cache er tom — bygg fra alle valgte spillere
      _sisteDeltakereCache = { spillerIds: [...app.valgtIds], hentetMs: Date.now() };
    }
    // Sørg for at panelet er åpent og oppdater listen
    if (!_sisteDeltakereApen) {
      _sisteDeltakereApen = true;
      const panel = document.getElementById('siste-deltakere-panel');
      const pil   = document.getElementById('siste-deltakere-pil');
      if (panel) panel.style.display = 'block';
      if (pil)   pil.style.transform = 'rotate(180deg)';
    }
    oppdaterSisteDeltakereInPlace();
    visMelding(navn + ' lagt til!');
  } catch (e) {
    visFBFeil('Kunne ikke legge til spiller: ' + (e?.message ?? e));
  }
}
window.leggTilSpiller = leggTilSpiller;

// ════════════════════════════════════════════════════════
// START ØKT
// ════════════════════════════════════════════════════════
async function startTrening() {
  if (!db) { visMelding('Firebase ikke tilkoblet.', 'feil'); return; }
  if (!aktivKlubbId) { visMelding('Velg en klubb først.', 'advarsel'); return; }
  // 6-spiller-format: nøyaktig 6 spillere og 2 baner
  const er6SpillerFormat = app.antallBaner === 2 && app.valgtIds.size === 6;
  const min = er6SpillerFormat ? 6 : app.antallBaner * 4;
  if (app.valgtIds.size < min) return;

  const valgte = [...app.valgtIds]
    .map(id => (app.spillere ?? []).find(s => s.id === id))
    .filter(Boolean);

  if (valgte.length < min) {
    visMelding('Noen valgte spillere finnes ikke lenger i databasen.', 'advarsel');
    return;
  }

  // ── Fordel spillere på baner ─────────────────────────────────────────────
  // KONKURRANSE : rating-sortert fordeling (beste øverst)
  // MIX         : smart matchmaking — minimerer partner/motstander-gjentakelse
  // 6-spiller/2-baner: alltid dobbel (4 spl) + singel (2 spl) uansett modus
  let baneOversikt, mixHviler = [];
  if (erMix()) {
    if (er6SpillerFormat) {
      // 6-spiller mix: tilfeldig fordeling til dobbel + singel
      const blandede = blandArray([...valgte]);
      const mp = app.poengPerKamp ?? 15;
      const dblSpl = blandede.slice(0, 4).map(s => ({ id: s.id, navn: s.navn ?? 'Ukjent', rating: s.rating ?? STARTRATING }));
      const sinSpl = blandede.slice(4, 6).map(s => ({ id: s.id, navn: s.navn ?? 'Ukjent', rating: s.rating ?? STARTRATING }));
      baneOversikt = [
        { baneNr: 1, erDobbel: true,  erSingel: false, maksPoeng: mp, spillere: dblSpl },
        { baneNr: 2, erDobbel: false, erSingel: true,  maksPoeng: mp, spillere: sinSpl },
      ];
    } else {
      const resultat = fordelBanerMix(valgte, app.antallBaner, app.poengPerKamp ?? 15);
      baneOversikt = resultat.baneOversikt;
      mixHviler    = resultat.hviler ?? [];
    }
  } else {
    baneOversikt = fordelBaner(valgte, app.antallBaner, app.poengPerKamp ?? 17);
  }

  // Guard: alle baner skal ha 2, 4 eller 5 spillere (2 = singel i 6-spiller-format)
  const ugyldigBane = baneOversikt.find(b => b.spillere.length < 2 || b.spillere.length > 5 || b.spillere.length === 3);
  if (ugyldigBane) {
    visMelding(`Bane ${ugyldigBane.baneNr} har ugyldig antall spillere (${ugyldigBane.spillere.length}).`, 'feil');
    return;
  }

  // Spillere som ikke fikk plass: i mix brukes hviler fra algoritmen, ellers beregnes det
  const venteliste = erMix()
    ? mixHviler.map(s => ({ id: s.id, navn: s.navn ?? 'Ukjent', rating: s.rating ?? STARTRATING }))
    : valgte
        .filter(s => !new Set(baneOversikt.flatMap(b => b.spillere.map(x => x.id))).has(s.id))
        .map(s => ({ id: s.id, navn: s.navn ?? 'Ukjent', rating: s.rating ?? STARTRATING }));

  // Maksrunder: 5-spillerbaner trenger 5 runder for full rotasjon
  // Bruk alltid brukerens valgte antall runder — ingen automatisk overstyring
  const effektivMaksRunder = app.maksRunder;

  try {
    const batch    = writeBatch(db);
    const treningRef = doc(collection(db, SAM.TRENINGER));

    // ── Mix & Match: initialiser statistikk-felter i Firestore ──────────────
    // Tomme ved runde 1 — oppdateres etter hver runde i bekreftNesteRunde.
    // Konkurranse-modus berøres ikke av disse feltene.
    const mixFelter = erMix() ? {
      mixPlayedWith:      {},
      mixPlayedAgainst:   {},
      mixGamesPlayed:     {},
      mixSitOutCount:     {},
      mixLastSitOutRunde: {},
    } : {};

    batch.set(treningRef, {
      antallBaner:     baneOversikt.length,
      poengPerKamp:    app.poengPerKamp,
      maksRunder:      effektivMaksRunder,
      gjeldendRunde:   1,
      status:          'aktiv',
      laast:           false,
      opprettetDato:   serverTimestamp(),
      avsluttetDato:   null,
      baneOversikt,
      venteliste,
      er6SpillerFormat: er6SpillerFormat,
      spillModus:      app.spillModus,
      klubbId:         aktivKlubbId,
      ...mixFelter,
    });

    baneOversikt.forEach(b => b.spillere.forEach(s => {
      batch.set(doc(collection(db, SAM.TS)), {
        treningId: treningRef.id, spillerId: s.id,
        spillerNavn: s.navn ?? 'Ukjent', ratingVedStart: s.rating ?? STARTRATING,
        sluttPlassering: null, paVenteliste: false,
      });
    }));
    venteliste.forEach(s => {
      batch.set(doc(collection(db, SAM.TS)), {
        treningId: treningRef.id, spillerId: s.id,
        spillerNavn: s.navn ?? 'Ukjent', ratingVedStart: s.rating ?? STARTRATING,
        sluttPlassering: null, paVenteliste: true,
      });
    });

    // Skriv kamper for runde 1
    if (erMix()) {
      skrivMixKamper(batch, treningRef.id, 1, baneOversikt);
    } else {
      baneOversikt.forEach(bane =>
        skrivKamper(batch, treningRef.id, 1, bane.baneNr, bane.spillere, bane.erSingel ?? false, bane.erDobbel ?? false)
      );
    }
    await batch.commit();

    app.treningId         = treningRef.id;
    app.baneOversikt      = baneOversikt;
    app.venteliste        = venteliste;
    app.runde             = 1;
    app.maksRunder        = effektivMaksRunder;
    app.er6SpillerFormat  = er6SpillerFormat;

    sessionStorage.setItem('aktivTreningId', treningRef.id);
    try { history.replaceState(null, '', '?okt=' + treningRef.id); } catch (_) {}
    oppdaterRundeUI();
    naviger('baner');
    startLyttere();
  } catch (e) {
    visFBFeil('Kunne ikke starte økt: ' + (e?.message ?? e));
  }
}
function delLenke() {
  const url = location.href;
  if (navigator.share) {
    navigator.share({ title: 'Pb Jæren Americano', url })
      .catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => {
      visMelding('Lenke kopiert!');
    }).catch(() => {
      visMelding('Kunne ikke kopiere lenke.', 'feil');
    });
  } else {
    prompt('Kopier lenken:', url);
  }
}
window.delLenke = delLenke;

window.startTrening = startTrening;

function skrivKamper(batch, treningId, rundeNr, baneNr, spillere, erSingel = false, erDobbel6 = false) {
  const n = spillere?.length ?? 0;
  // 6-spiller singel-bane har 2 spillere; vanlige baner trenger minst 4
  if (erSingel && n === 2) {
    const dokData = {
      treningId, baneNr: `bane${baneNr}`, rundeNr, kampNr: 1,
      erSingel: true,
      lag1_s1: spillere[0].id,  lag1_s2: null,
      lag2_s1: spillere[1].id,  lag2_s2: null,
      lag1_s1_navn: spillere[0].navn, lag1_s2_navn: null,
      lag2_s1_navn: spillere[1].navn, lag2_s2_navn: null,
      lag1Poeng: null, lag2Poeng: null, ferdig: false,
    };
    batch.set(doc(collection(db, SAM.KAMPER)), dokData);
    return;
  }
  if (n < 4) {
    console.warn(`skrivKamper: bane ${baneNr} har kun ${n} spillere — hopper over.`);
    return;
  }
  const parter = erDobbel6 ? PARTER_6_DOBBEL : getParter(n);
  parter.forEach(par => {
    const dokData = {
      treningId, baneNr: `bane${baneNr}`, rundeNr, kampNr: par.nr,
      erSingel: false,
      lag1_s1: spillere[par.lag1[0]].id,  lag1_s2: spillere[par.lag1[1]].id,
      lag2_s1: spillere[par.lag2[0]].id,  lag2_s2: spillere[par.lag2[1]].id,
      lag1_s1_navn: spillere[par.lag1[0]].navn, lag1_s2_navn: spillere[par.lag1[1]].navn,
      lag2_s1_navn: spillere[par.lag2[0]].navn, lag2_s2_navn: spillere[par.lag2[1]].navn,
      lag1Poeng: null, lag2Poeng: null, ferdig: false,
    };
    // For 5-spillerbaner: lagre hvem som hviler
    if (par.hviler != null && spillere[par.hviler]) {
      dokData.hviler_id   = spillere[par.hviler].id;
      dokData.hviler_navn = spillere[par.hviler].navn;
    }
    batch.set(doc(collection(db, SAM.KAMPER)), dokData);
  });
}

// Mix & Match — skriv én kamp per bane per runde.
// Håndterer både dobbel (4 spl) og singel (2 spl) baner.
function skrivMixKamper(batch, treningId, rundeNr, baneOversikt) {
  baneOversikt.forEach(bane => {
    const spl = bane.spillere ?? [];

    // Singel-bane (2 spillere)
    if (bane.erSingel || spl.length === 2) {
      const [s1, s2] = spl;
      if (!s1 || !s2) return;
      batch.set(doc(collection(db, SAM.KAMPER)), {
        treningId,
        baneNr:   `bane${bane.baneNr}`,
        rundeNr,
        kampNr:   1,
        erSingel: true,
        lag1_s1: s1.id, lag1_s2: null,
        lag2_s1: s2.id, lag2_s2: null,
        lag1_s1_navn: s1.navn, lag1_s2_navn: null,
        lag2_s1_navn: s2.navn, lag2_s2_navn: null,
        lag1Poeng: null, lag2Poeng: null, ferdig: false,
      });
      return;
    }

    // Dobbel-bane (4 spillere)
    const [s1, s2, s3, s4] = spl;
    if (!s1 || !s2 || !s3 || !s4) return;
    batch.set(doc(collection(db, SAM.KAMPER)), {
      treningId,
      baneNr:   `bane${bane.baneNr}`,
      rundeNr,
      kampNr:   1,
      erSingel: false,
      lag1_s1: s1.id, lag1_s2: s2.id,
      lag2_s1: s3.id, lag2_s2: s4.id,
      lag1_s1_navn: s1.navn, lag1_s2_navn: s2.navn,
      lag2_s1_navn: s3.navn, lag2_s2_navn: s4.navn,
      lag1Poeng: null, lag2Poeng: null, ferdig: false,
    });
  });
}
// ════════════════════════════════════════════════════════
// Separat referanse til kamp-lytteren slik at den kan restartes ved ny runde
let kampLytterAvmeld = null;

function startKampLytter() {
  if (!db || !app.treningId) return;
  // Stopp gammel kamp-lytter om den finnes
  if (kampLytterAvmeld) { try { kampLytterAvmeld(); } catch (_) {} kampLytterAvmeld = null; }
  kampStatusCache = {};

  kampLytterAvmeld = onSnapshot(
    query(collection(db, SAM.KAMPER),
      where('treningId', '==', app.treningId),
      where('rundeNr',   '==', app.runde)   // bruker alltid gjeldende app.runde
    ),
    snap => {
      oppdaterKampStatus(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    },
    feil => visFBFeil('Lyttefeil (kamper): ' + (feil?.message ?? feil))
  );
}

function startLyttere() {
  if (!db || !app.treningId) return;

  const l1 = onSnapshot(
    doc(db, SAM.TRENINGER, app.treningId),
    snap => {
      if (!snap.exists()) return;
      const data = snap.data() ?? {};
      const forrigeRunde = app.runde;
      app.runde        = data.gjeldendRunde ?? app.runde;
      app.baneOversikt = data.baneOversikt  ?? [];
      app.venteliste   = data.venteliste    ?? [];
      oppdaterRundeUI();
      visBanerDebounced();

      // Økt avsluttet av admin — naviger alle til sluttresultat
      if (data.status === 'avsluttet') {
        if (app.treningId) sessionStorage.setItem('aktivTreningId', app.treningId);
        stoppLyttere();
        naviger('slutt');
        return;
      }

      // Ny runde startet av admin — restart kamp-lytter og naviger til baneoversikten
      if (app.runde > forrigeRunde && forrigeRunde !== 0) {
        startKampLytter();
        naviger('baner');
      }
    },
    feil => visFBFeil('Lyttefeil (økt): ' + (feil?.message ?? feil))
  );

  app.lyttere.push(l1);
  startKampLytter();  // start kamp-lytter for gjeldende runde
}

function stoppLyttere() {
  app.lyttere.forEach(l => { try { l(); } catch (_) {} });
  app.lyttere = [];
  if (kampLytterAvmeld) { try { kampLytterAvmeld(); } catch (_) {} kampLytterAvmeld = null; }
}

// ════════════════════════════════════════════════════════
// RUNDE-UI
// ════════════════════════════════════════════════════════
function oppdaterRundeUI() {
  const rundeHdr = document.getElementById('runde-hdr');
  const maksHdr  = document.getElementById('maks-runder-hdr');
  if (rundeHdr) rundeHdr.textContent = app.runde;
  if (maksHdr)  maksHdr.textContent  = app.maksRunder;

  // Mix: annen sub-header i bane-headeren
  const banerSub = document.getElementById('baner-hdr-sub');
  if (banerSub) banerSub.textContent = erMix() ? 'Mix & Match' : 'Baneoversikt';

  // Mix-merke — kun synlig i Mix & Match-modus
  const mixMerkeEl = document.getElementById('mix-modus-merke');
  if (mixMerkeEl) mixMerkeEl.style.display = erMix() ? 'inline-flex' : 'none';

  // Mix: bruk "Kamp" i stedet for "Runde"
  if (erMix()) {
    const appName = document.querySelector('#skjerm-baner .app-name');
    if (appName) appName.innerHTML = `Kamp <span id="runde-hdr">${app.runde}</span>/<span id="maks-runder-hdr">${app.maksRunder}</span>`;
    document.getElementById('runde-indikator-tekst').textContent =
      `Kamp ${app.runde} av ${app.maksRunder} — trykk på en bane for å registrere poeng 🎲`;
  } else {
    const appName = document.querySelector('#skjerm-baner .app-name');
    if (appName) appName.innerHTML = `Runde <span id="runde-hdr">${app.runde}</span>/<span id="maks-runder-hdr">${app.maksRunder}</span>`;
    document.getElementById('runde-indikator-tekst').textContent =
      `Runde ${app.runde} av ${app.maksRunder} pågår — trykk på en bane for å registrere poeng`;
  }

  // Sett tekst på neste-kamp/neste-runde-knappen
  const nesteKnapp = document.getElementById('neste-runde-knapp');
  if (nesteKnapp) nesteKnapp.textContent = erMix() ? 'NESTE KAMP →' : 'NESTE RUNDE →';

  const wrap = document.getElementById('fremgang-beholder');
  let h = '';
  for (let i = 1; i <= app.maksRunder; i++) {
    const kl = i < app.runde ? 'ferdig' : i === app.runde ? 'aktiv' : '';
    h += `<div class="fremgang-prikk ${kl}"></div>`;
  }
  h += `<span class="fremgang-tekst">${erMix() ? 'Kamp' : 'Runde'} ${app.runde} av ${app.maksRunder}</span>`;
  wrap.innerHTML = h;
}

// ════════════════════════════════════════════════════════
// BANEOVERSIKT
// ════════════════════════════════════════════════════════
let kampStatusCache = {};

let _visBanerTimer = null;
function visBanerDebounced() {
  clearTimeout(_visBanerTimer);
  _visBanerTimer = setTimeout(visBaner, 50);
}

function oppdaterKampStatus(kamper) {
  kampStatusCache = {};
  (kamper ?? []).forEach(k => {
    if (k?.baneNr && k?.kampNr != null) {
      kampStatusCache[`${k.baneNr}_${k.kampNr}`] = k;
    }
  });
  const baneLaster = document.getElementById('bane-laster');
  if (baneLaster) baneLaster.style.display = 'none';
  visBanerDebounced();
}

function visBaner() {
  // Ingen aktiv økt — vis tom tilstand og skjul alt
  if (!app.treningId) {
    const rh = document.getElementById('runde-hdr');
    const mh = document.getElementById('maks-runder-hdr');
    if (rh) rh.textContent = '—';
    if (mh) mh.textContent = '—';
    document.getElementById('runde-indikator-tekst').textContent = 'Ingen aktiv økt';
    document.getElementById('fremgang-beholder').innerHTML    = '';
    document.getElementById('venteliste-visning').innerHTML   = '';
    document.getElementById('bane-liste').innerHTML =
      '<div style="padding:30px 0;text-align:center;color:var(--muted2);font-size:17px">' +
      'Ingen økt pågår. Gå til <strong style="color:var(--white)">Hjem</strong>-fanen for å starte ny økt.</div>';
    document.getElementById('neste-runde-knapp').disabled = true;
    return;
  }

  const vl     = app.venteliste ?? [];
  const vlWrap = document.getElementById('venteliste-visning');
  if (vl.length > 0) {
    vlWrap.innerHTML = `<div class="venteliste-boks">
      <div class="venteliste-tittel">Venteliste (${vl.length})</div>
      ${vl.map((s,i) => `<div class="vl-rad">
        <div class="vl-pos">#${i+1}</div>
        <div style="flex:1">${s.navn ?? 'Ukjent'}</div>
        <div style="font-family:'DM Mono',monospace;font-size:14px;color:var(--muted2)">⭐ ${s.rating ?? STARTRATING}</div>
      </div>`).join('')}
    </div>`;
  } else {
    vlWrap.innerHTML = '';
  }

  document.getElementById('bane-liste').innerHTML = (app.baneOversikt ?? []).map(bane => {
    const antallSpillere = bane?.spillere?.length ?? 0;
    const erSingelBane = bane?.erSingel === true || antallSpillere === 2;
    if (antallSpillere < 2) return '';

    // ── Mix & Match: én enkel kamp per bane, ingen K1/K2/K3 ──
    if (erMix()) {
      const k      = kampStatusCache[`bane${bane.baneNr}_1`];
      const ferdig = k?.ferdig === true;
      // Hent lagnavnene fra Firestore-kampen om tilgjengelig, ellers fra baneOversikt
      const lag1 = k
        ? `${k.lag1_s1_navn ?? '?'} + ${k.lag1_s2_navn ?? '?'}`
        : `${bane.spillere[0]?.navn ?? '?'} + ${bane.spillere[1]?.navn ?? '?'}`;
      const lag2 = k
        ? `${k.lag2_s1_navn ?? '?'} + ${k.lag2_s2_navn ?? '?'}`
        : `${bane.spillere[2]?.navn ?? '?'} + ${bane.spillere[3]?.navn ?? '?'}`;
      const baneMaksPoeng  = bane.maksPoeng ?? app.poengPerKamp ?? 15;
      const spillTilMerke  = `<span style="font-size:12px;background:rgba(37,99,235,.12);color:var(--accent2);border-radius:4px;padding:2px 7px;font-weight:700">Til ${baneMaksPoeng}</span>`;
      return `<div class="kort" style="cursor:pointer" onclick="apnePoenginput(${bane.baneNr})">
        <div class="kort-hode">
          <div style="display:flex;align-items:baseline;gap:10px">
            <div class="bane-nummer-stor" style="color:var(--green2)">${bane.baneNr}</div>
            <div>
              <div style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted2)">Bane ${spillTilMerke}</div>
              <div style="font-size:15px;color:${ferdig ? 'var(--green2)' : 'var(--muted2)'};font-weight:600">${ferdig ? '✓ Ferdig' : 'Mangler poeng'}</div>
            </div>
          </div>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
        </div>
        <div class="kort-innhold">
          <div class="kamp-rad">
            <div style="flex:1">
              <div class="kamp-lag">${lag1}</div>
              <div class="kamp-mot">mot</div>
              <div class="kamp-lag">${lag2}</div>
            </div>
            <div class="kamp-poeng-merke ${ferdig ? 'poeng-ferdig' : 'poeng-mangler'}">
              ${ferdig ? `${k.lag1Poeng}–${k.lag2Poeng}` : '—'}
            </div>
          </div>
        </div>
      </div>`;
    }

    // ── Singel-bane (6-spiller-format) ──
    if (erSingelBane) {
      const k      = kampStatusCache[`bane${bane.baneNr}_1`];
      const ferdig = k?.ferdig === true;
      const s      = bane.spillere;
      const rad = `<div class="kamp-rad">
        <div class="kamp-nummer">K1</div>
        <div style="flex:1">
          <div class="kamp-lag" style="color:var(--white)">${s[0]?.navn ?? '?'}</div>
          <div class="kamp-mot">mot</div>
          <div class="kamp-lag" style="color:var(--white)">${s[1]?.navn ?? '?'}</div>
        </div>
        <div class="kamp-poeng-merke ${ferdig?'poeng-ferdig':'poeng-mangler'}">
          ${ferdig ? `${k.lag1Poeng}–${k.lag2Poeng}` : '—'}
        </div>
      </div>`;
      const baneMaksPoeng = bane.maksPoeng ?? app.poengPerKamp ?? 15;
      const spillTilMerke = `<span style="font-size:12px;background:rgba(37,99,235,.12);color:var(--accent2);border-radius:4px;padding:2px 7px;font-weight:700;letter-spacing:.3px">Til ${baneMaksPoeng}</span>`;
      const singelMerke = `<span style="font-size:12px;background:rgba(234,179,8,.15);color:var(--yellow);border-radius:4px;padding:2px 7px;font-weight:700;letter-spacing:.5px">🏃 SINGEL</span>`;
      return `<div class="kort" style="cursor:pointer" onclick="apnePoenginput(${bane.baneNr})">
        <div class="kort-hode">
          <div style="display:flex;align-items:baseline;gap:10px">
            <div class="bane-nummer-stor" style="color:var(--yellow)">${bane.baneNr}</div>
            <div>
              <div style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted2);display:flex;align-items:center;gap:6px">Singel ${singelMerke} ${spillTilMerke}</div>
              <div style="font-size:15px;color:${ferdig?'var(--green2)':'var(--muted2)'};font-weight:600">${ferdig?'✓ Ferdig':'Mangler poeng'}</div>
            </div>
          </div>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
        </div>
        <div class="kort-innhold">${rad}</div>
      </div>`;
    }

    // ── Dobbel-bane (normal eller 6-spiller-format) ──
    if (antallSpillere < 4) return '';
    // 6-spiller dobbel-bane har kun 1 kamp (PARTER_6_DOBBEL), ikke 3 (PARTER)
    const parter = (app.er6SpillerFormat && bane.erDobbel) ? PARTER_6_DOBBEL : getParter(antallSpillere);
    const rader = parter.map(par => {
      const k      = kampStatusCache[`bane${bane.baneNr}_${par.nr}`];
      const ferdig = k?.ferdig === true;
      const s      = bane.spillere;
      const hvilerNavn = par.hviler != null ? (s[par.hviler]?.navn ?? null) : null;
      return `<div class="kamp-rad">
        <div class="kamp-nummer">K${par.nr}</div>
        <div style="flex:1">
          <div class="kamp-lag">${s[par.lag1[0]]?.navn ?? '?'} + ${s[par.lag1[1]]?.navn ?? '?'}</div>
          <div class="kamp-mot">mot</div>
          <div class="kamp-lag">${s[par.lag2[0]]?.navn ?? '?'} + ${s[par.lag2[1]]?.navn ?? '?'}</div>
          ${hvilerNavn ? `<div style="font-size:13px;color:var(--orange);margin-top:4px">💤 ${hvilerNavn} hviler</div>` : ''}
        </div>
        <div class="kamp-poeng-merke ${ferdig?'poeng-ferdig':'poeng-mangler'}">
          ${ferdig ? `${k.lag1Poeng}–${k.lag2Poeng}` : '—'}
        </div>
      </div>`;
    }).join('');
    const alleFerdig = parter.every(par => kampStatusCache[`bane${bane.baneNr}_${par.nr}`]?.ferdig === true);
    const bane5merke = antallSpillere === 5
      ? `<span style="font-size:12px;background:rgba(234,88,12,.15);color:var(--orange);border-radius:4px;padding:2px 7px;font-weight:700;letter-spacing:.5px">5 SPL</span>`
      : '';
    const dobbelMerke = app.er6SpillerFormat
      ? `<span style="font-size:12px;background:rgba(37,99,235,.15);color:var(--accent2);border-radius:4px;padding:2px 7px;font-weight:700;letter-spacing:.5px">🎾 DOBBEL</span>`
      : '';
    const baneMaksPoeng = bane.maksPoeng ?? (app.poengPerKamp ?? 17);
    const spillTilMerke = `<span style="font-size:12px;background:rgba(37,99,235,.12);color:var(--accent2);border-radius:4px;padding:2px 7px;font-weight:700;letter-spacing:.3px">Til ${baneMaksPoeng}</span>`;
    return `<div class="kort" style="cursor:pointer" onclick="apnePoenginput(${bane.baneNr})">
      <div class="kort-hode">
        <div style="display:flex;align-items:baseline;gap:10px">
          <div class="bane-nummer-stor">${bane.baneNr}</div>
          <div>
            <div style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted2);display:flex;align-items:center;gap:6px">Bane ${bane5merke} ${dobbelMerke} ${spillTilMerke}</div>
            <div style="font-size:15px;color:${alleFerdig?'var(--green2)':'var(--muted2)'};font-weight:600">${alleFerdig?'✓ Ferdig':'Mangler poeng'}</div>
          </div>
        </div>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      </div>
      <div class="kort-innhold">${rader}</div>
    </div>`;
  }).join('');

  const alleBanerFerdig = (app.baneOversikt ?? []).length > 0 &&
    (app.baneOversikt ?? []).every(bane => {
      const n = bane?.spillere?.length ?? 0;
      if (n < 2) return false;
      // Mix: alltid kun K1 per bane
      if (erMix()) return kampStatusCache[`bane${bane.baneNr}_1`]?.ferdig === true;
      const erSingelBane = bane?.erSingel === true || n === 2;
      if (erSingelBane) return kampStatusCache[`bane${bane.baneNr}_1`]?.ferdig === true;
      const parterFerdig = (app.er6SpillerFormat && bane.erDobbel) ? PARTER_6_DOBBEL : getParter(n);
      return parterFerdig.every(par => kampStatusCache[`bane${bane.baneNr}_${par.nr}`]?.ferdig === true);
    });
  document.getElementById('neste-runde-knapp').disabled = !alleBanerFerdig;
  oppdaterAvbrytKnapp();
}

// ════════════════════════════════════════════════════════
// POENGREGISTRERING + VALIDERING
// ════════════════════════════════════════════════════════
function apnePoenginput(baneNr) {
  const bane = (app.baneOversikt ?? []).find(b => b.baneNr === baneNr);
  const erSingelGuard = bane?.erSingel === true || (bane?.spillere?.length === 2);
  if (!bane || !bane.spillere || (!erSingelGuard && bane.spillere.length < 4)) {
    visMelding('Banedataen er ikke tilgjengelig.', 'feil');
    return;
  }
  app.aktivBane = baneNr;
  document.getElementById('poeng-bane-nummer').textContent = baneNr;
  document.getElementById('poeng-bane-stor').textContent   = baneNr;
  const maksPoeng = bane.maksPoeng ?? (app.poengPerKamp ?? 17);
  document.getElementById('maks-hint').textContent         = maksPoeng;
  document.getElementById('valider-feil').style.display    = 'none';
  const doneBtn = document.getElementById('done-knapp');
  if (doneBtn) doneBtn.style.display = 'none';

  const erSingelBane = bane?.erSingel === true || bane.spillere.length === 2;
  // Mix: alltid én kamp per bane (K1) — hent lagnavnene fra kampdata
  const erDobbelBane6 = app.er6SpillerFormat && (bane?.erDobbel === true);
  const parter = erMix()
    ? [{ nr: 1, lag1: [0, 1], lag2: [2, 3] }]   // én fast kamp
    : (erSingelBane ? PARTER_6_SINGEL : (erDobbelBane6 ? PARTER_6_DOBBEL : getParter(bane.spillere.length)));

  const eksisterende = {};
  parter.forEach(par => {
    const k = kampStatusCache[`bane${baneNr}_${par.nr}`];
    if (k?.ferdig) eksisterende[par.nr] = { l1: k.lag1Poeng, l2: k.lag2Poeng };
  });

  // Mix: hent spillernavn fra kampdata (K1) i stedet for bane.spillere
  const mixKamp = erMix() ? (kampStatusCache[`bane${baneNr}_1`] ?? null) : null;

  document.getElementById('poeng-kamper').innerHTML = parter.map((par, i) => {
    const e   = eksisterende[par.nr];
    const s   = bane.spillere;

    // ── Singel-kamp: 1 vs 1 ──
    if (erSingelBane) {
      const l1n = s[0]?.navn ?? '?';
      const l2n = s[1]?.navn ?? '?';
      const statusHTML = e != null
        ? `<div class="kamp-status lagret" id="kamp-status-${i}">✓ Lagret</div>`
        : `<div class="kamp-status" id="kamp-status-${i}"></div>`;
      return `<div class="kamp-kort" id="kk-${i}">
        <div class="kamp-hode">
          🏃 Singel <span class="kamp-merke" style="background:rgba(234,179,8,.15);color:var(--yellow)">1 vs 1</span>
          ${statusHTML}
        </div>
        <div style="text-align:center;font-size:14px;color:var(--yellow);padding:6px 0 2px;font-weight:600">Singel — spill til ${bane.maksPoeng ?? app.poengPerKamp ?? 15} poeng</div>
        <div class="lag-rad">
          <div class="lag-boks">
            <div class="lag-navn" style="color:var(--white);font-weight:600">${escHtml(l1n)}</div>
            <input class="poeng-inndata" type="text" inputmode="numeric" pattern="[0-9]*" id="s${i}_l1"
              placeholder="0" value="${e != null ? e.l1 : ''}"
              oninput="validerInndata(${i}, 'l1')" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"/>
          </div>
          <div class="vs-deler">–</div>
          <div class="lag-boks">
            <div class="lag-navn" style="color:var(--white);font-weight:600">${escHtml(l2n)}</div>
            <input class="poeng-inndata" type="text" inputmode="numeric" pattern="[0-9]*" id="s${i}_l2"
              placeholder="0" value="${e != null ? e.l2 : ''}"
              oninput="validerInndata(${i}, 'l2')" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"/>
          </div>
        </div>
      </div>`;
    }

    // ── Dobbel-kamp: 2 vs 2 ──
    // Mix: hent lagnavnene fra Firestore-kampdata (riktig rekkefølge)
    const l1n = mixKamp
      ? `${mixKamp.lag1_s1_navn ?? '?'} + ${mixKamp.lag1_s2_navn ?? '?'}`
      : `${s[par.lag1[0]]?.navn ?? '?'} + ${s[par.lag1[1]]?.navn ?? '?'}`;
    const l2n = mixKamp
      ? `${mixKamp.lag2_s1_navn ?? '?'} + ${mixKamp.lag2_s2_navn ?? '?'}`
      : `${s[par.lag2[0]]?.navn ?? '?'} + ${s[par.lag2[1]]?.navn ?? '?'}`;
    const hvilerHTML = par.hviler != null && s[par.hviler]
      ? `<div style="text-align:center;font-size:14px;color:var(--orange);padding:6px 0 2px">💤 ${escHtml(s[par.hviler].navn)} hviler — får snittpoeng</div>`
      : '';
    const statusHTML = e != null
      ? `<div class="kamp-status lagret" id="kamp-status-${i}">✓ Lagret</div>`
      : `<div class="kamp-status" id="kamp-status-${i}"></div>`;
    return `<div class="kamp-kort" id="kk-${i}">
      <div class="kamp-hode">
        Kamp ${par.nr} <span class="kamp-merke">Americano</span>
        ${statusHTML}
      </div>
      ${hvilerHTML}
      <div class="lag-rad">
        <div class="lag-boks">
          <div class="lag-navn">${escHtml(l1n)}</div>
          <input class="poeng-inndata" type="text" inputmode="numeric" pattern="[0-9]*" id="s${i}_l1"
            placeholder="0" value="${e != null ? e.l1 : ''}"
            oninput="validerInndata(${i}, 'l1')" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"/>
        </div>
        <div class="vs-deler">–</div>
        <div class="lag-boks">
          <div class="lag-navn">${escHtml(l2n)}</div>
          <input class="poeng-inndata" type="text" inputmode="numeric" pattern="[0-9]*" id="s${i}_l2"
            placeholder="0" value="${e != null ? e.l2 : ''}"
            oninput="validerInndata(${i}, 'l2')" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"/>
        </div>
      </div>
    </div>`;
  }).join('');
  naviger('poeng');
  oppdaterPoengNav();

  setTimeout(() => {
    for (let i = 0; i < parter.length; i++) {
      const el = document.getElementById(`s${i}_l1`);
      if (el && el.value === '') { el.focus(); break; }
    }
  }, 180);
}
window.apnePoenginput = apnePoenginput;

// Naviger til forrige/neste bane fra poengregistreringsskjermen.
// retning: -1 = forrige, +1 = neste
// Hvis neste og alle baner er ferdige: gå til resultater.
function navigerBane(retning) {
  const baner     = app.baneOversikt ?? [];
  const gjeldende = app.aktivBane ?? 1;
  const idx       = baner.findIndex(b => b.baneNr === gjeldende);

  if (retning === -1) {
    // Forrige bane, eller tilbake til oversikt
    if (idx <= 0) { naviger('baner'); return; }
    apnePoenginput(baner[idx - 1].baneNr);
  } else {
    // Sjekk om alle baner er ferdig — da: vis resultater
    const alleFerdig = baner.length > 0 && baner.every(bane => {
      if (erMix()) return kampStatusCache[`bane${bane.baneNr}_1`]?.ferdig === true;
      const n = bane?.spillere?.length ?? 0;
      if (bane?.erSingel || n === 2) return kampStatusCache[`bane${bane.baneNr}_1`]?.ferdig === true;
      const parter = (app.er6SpillerFormat && bane.erDobbel) ? PARTER_6_DOBBEL : getParter(n);
      return parter.every(p => kampStatusCache[`bane${bane.baneNr}_${p.nr}`]?.ferdig === true);
    });

    if (alleFerdig) {
      // Alle baner ferdig — gå til "se resultater"
      visNesteRundeModal();
      return;
    }

    if (idx >= baner.length - 1) {
      // Siste bane men ikke alle ferdig — gå tilbake til oversikt
      naviger('baner');
      return;
    }
    apnePoenginput(baner[idx + 1].baneNr);
  }
}
window.navigerBane = navigerBane;
// Oppdater Forrige/Neste-knappene basert på gjeldende bane og status
function oppdaterPoengNav() {
  const baner     = app.baneOversikt ?? [];
  const gjeldende = app.aktivBane ?? 1;
  const idx       = baner.findIndex(b => b.baneNr === gjeldende);

  const forrigeKnapp = document.getElementById('poeng-forrige-knapp');
  const nesteKnapp   = document.getElementById('poeng-neste-knapp');
  if (!forrigeKnapp || !nesteKnapp) return;

  // Forrige: alltid tilgjengelig (bane 1 → tilbake til oversikt)
  forrigeKnapp.textContent = idx <= 0 ? '← Oversikt' : `← Bane ${baner[idx - 1]?.baneNr}`;

  // Neste: sjekk om alle baner er ferdig
  const alleFerdig = baner.length > 0 && baner.every(bane => {
    if (erMix()) return kampStatusCache[`bane${bane.baneNr}_1`]?.ferdig === true;
    const n = bane?.spillere?.length ?? 0;
    if (bane?.erSingel || n === 2) return kampStatusCache[`bane${bane.baneNr}_1`]?.ferdig === true;
    const parter = (app.er6SpillerFormat && bane.erDobbel) ? PARTER_6_DOBBEL : getParter(n);
    return parter.every(p => kampStatusCache[`bane${bane.baneNr}_${p.nr}`]?.ferdig === true);
  });

  if (alleFerdig) {
    nesteKnapp.textContent = '🏁 Se resultater';
    nesteKnapp.className   = 'knapp knapp-gronn';
  } else if (idx >= baner.length - 1) {
    nesteKnapp.textContent = '← Tilbake til oversikt';
    nesteKnapp.className   = 'knapp knapp-omriss';
  } else {
    nesteKnapp.textContent = `Bane ${baner[idx + 1]?.baneNr} →`;
    nesteKnapp.className   = 'knapp knapp-primaer';
  }
}
window.oppdaterPoengNav = oppdaterPoengNav;


// Debounce-timere per kamp-indeks — autosave venter 800ms etter siste tastetrykk
const autosaveTimere = {};

function validerInndata(i, endretFelt) {
  ['l1','l2'].forEach(lag => {
    const el = document.getElementById(`s${i}_${lag}`);
    el.value = el.value.replace(/[^0-9]/g, '');
  });

  const el1  = document.getElementById(`s${i}_l1`);
  const el2  = document.getElementById(`s${i}_l2`);
  const l1   = parseInt(el1.value, 10);
  const l2   = parseInt(el2.value, 10);
  const bane = (app.baneOversikt ?? []).find(b => b.baneNr === app.aktivBane);
  const erSingelValider = bane?.erSingel === true || (bane?.spillere?.length === 2);
  const maks = bane?.maksPoeng ?? (app.poengPerKamp ?? 17);

  // Autofyll motstanderens poeng
  let autofylte = false;
  if (endretFelt === 'l1' && !isNaN(l1) && l1 >= 0 && l1 <= maks && el2.value === '') {
    el2.value = String(maks - l1);
    autofylte = true;
  } else if (endretFelt === 'l2' && !isNaN(l2) && l2 >= 0 && l2 <= maks && el1.value === '') {
    el1.value = String(maks - l2);
    autofylte = true;
  }

  // Auto-hopp til neste tomme kamp etter autofyll
  if (autofylte) {
    const erSingelHopp = bane?.erSingel === true || (bane?.spillere?.length === 2);
    const erDobbelHopp6 = app.er6SpillerFormat && (bane?.erDobbel === true);
    const antallKamper = erSingelHopp
      ? PARTER_6_SINGEL.length
      : (erDobbelHopp6 ? PARTER_6_DOBBEL.length : getParter(bane?.spillere?.length ?? 4).length);
    setTimeout(() => {
      for (let neste = i + 1; neste < antallKamper; neste++) {
        const nesteEl = document.getElementById(`s${neste}_l1`);
        if (nesteEl && nesteEl.value === '') { nesteEl.focus(); return; }
      }
      document.activeElement?.blur();
    }, 80);
  }

  const v1  = parseInt(el1.value, 10);
  const v2  = parseInt(el2.value, 10);
  const ok  = !isNaN(v1) && !isNaN(v2) && v1 >= 0 && v2 >= 0 && v1 + v2 === maks;
  const kort = document.getElementById(`kk-${i}`);

  if (!isNaN(v1) && !isNaN(v2)) {
    kort.classList.toggle('ugyldig', !ok);
    el1.classList.toggle('ugyldig', !ok);
    el2.classList.toggle('ugyldig', !ok);
  } else {
    kort.classList.remove('ugyldig');
    el1.classList.remove('ugyldig');
    el2.classList.remove('ugyldig');
  }

  // Autosave: kanseller forrige timer og start ny 800ms-nedtelling
  clearTimeout(autosaveTimere[i]);
  if (ok) {
    settKampStatus(i, 'lagrer', '…');
    autosaveTimere[i] = setTimeout(() => autolagreKamp(i, v1, v2), 800);
  } else {
    settKampStatus(i, '', '');
  }
}
window.validerInndata = validerInndata;

/** Oppdaterer statuslinjen i kamp-kortets header. */
function settKampStatus(i, type, tekst) {
  const el = document.getElementById(`kamp-status-${i}`);
  if (!el) return;
  el.className = 'kamp-status' + (type ? ' ' + type : '');
  el.textContent = tekst;
}

/** Henter kamp-dokument-ID fra cache eller Firestore for én bestemt kamp. */
async function hentKampDokId(baneNr, kampNr) {
  const cachenøkkel = `${baneNr}_${kampNr}`;
  if (kampStatusCache[cachenøkkel]?.id) return kampStatusCache[cachenøkkel].id;
  const snap = await getDocs(query(
    collection(db, SAM.KAMPER),
    where('treningId', '==', app.treningId),
    where('rundeNr',   '==', app.runde),
    where('baneNr',    '==', baneNr),
    where('kampNr',    '==', kampNr)
  ));
  return snap.docs[0]?.id ?? null;
}

/** Lagrer én kamp til Firestore automatisk — kalles av debounce-timer. */
async function autolagreKamp(i, l1, l2) {
  if (!db || !app.treningId) return;

  const baneNr = app.aktivBane;
  const bane   = (app.baneOversikt ?? []).find(b => b.baneNr === baneNr);
  const erSingelLagre  = bane?.erSingel === true || (bane?.spillere?.length === 2);
  const erDobbelLagre6 = app.er6SpillerFormat && (bane?.erDobbel === true);
  const parter = erMix()
    ? [{ nr: 1, lag1: [0, 1], lag2: [2, 3] }]
    : (erSingelLagre ? PARTER_6_SINGEL : (erDobbelLagre6 ? PARTER_6_DOBBEL : getParter(bane?.spillere?.length ?? 4)));
  const par = parter[i];
  if (!par) return;

  try {
    const kampId = await hentKampDokId(`bane${baneNr}`, par.nr);
    if (!kampId) { settKampStatus(i, 'feil-status', '✗ Fant ikke kamp'); return; }

    const oppdatering = { lag1Poeng: l1, lag2Poeng: l2, ferdig: true };
    if (!erSingelLagre && par.hviler != null && bane?.spillere?.[par.hviler]) {
      oppdatering.hvilerPoeng = Math.ceil((l1 + l2) / 2);
    }

    const batch = writeBatch(db);
    batch.update(doc(db, SAM.KAMPER, kampId), oppdatering);
    batch.update(doc(db, SAM.TRENINGER, app.treningId), { sisteAktivitetDato: serverTimestamp() });
    await batch.commit();

    settKampStatus(i, 'lagret', '✓ Lagret');
    document.getElementById(`kk-${i}`)?.classList.remove('ugyldig');
    oppdaterPoengNav(); // oppdater Neste-knappen — kan nå vise "Se resultater"
  } catch (e) {
    console.error('[autolagreKamp]', e);
    settKampStatus(i, 'feil-status', '✗ Lagring feilet');
  }
}
window.autolagreKamp = autolagreKamp;

function lukkTastaturOgScrollTilLagre() {
  // Fjern fokus fra alle input → lukker tastaturet på iOS
  document.activeElement?.blur();
  const lagreKnapp = document.getElementById('lagre-poeng-knapp');
  if (lagreKnapp) lagreKnapp.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
window.lukkTastaturOgScrollTilLagre = lukkTastaturOgScrollTilLagre;

function lesOgValiderPoeng() {
  const bane   = (app.baneOversikt ?? []).find(b => b.baneNr === app.aktivBane);
  const erSingelLOV = bane?.erSingel === true || (bane?.spillere?.length === 2);
  const erDobbelLOV6 = app.er6SpillerFormat && (bane?.erDobbel === true);
  const parter = erSingelLOV ? PARTER_6_SINGEL : (erDobbelLOV6 ? PARTER_6_DOBBEL : getParter(bane?.spillere?.length ?? 4));
  const maks   = bane?.maksPoeng ?? (app.poengPerKamp ?? 17);
  const feil = [];
  const poeng = [];
  for (let i = 0; i < parter.length; i++) {
    const l1 = parseInt(document.getElementById(`s${i}_l1`).value, 10);
    const l2 = parseInt(document.getElementById(`s${i}_l2`).value, 10);
    if (isNaN(l1) || isNaN(l2)) {
      feil.push(`Kamp ${i+1}: Poeng mangler.`); poeng.push(null); continue;
    }
    if (l1 < 0 || l2 < 0)         feil.push(`Kamp ${i+1}: Negative tall er ikke tillatt.`);
    if (l1 > maks || l2 > maks)   feil.push(`Kamp ${i+1}: Maks ${maks} poeng per lag.`);
    if (l1 + l2 !== maks)         feil.push(`Kamp ${i+1}: ${l1} + ${l2} = ${l1+l2}, skal være ${maks}.`);
    poeng.push({ l1, l2 });
  }
  return { feil, poeng };
}

// ════════════════════════════════════════════════════════
// NESTE RUNDE + FORFLYTNING
// ════════════════════════════════════════════════════════
function visNesteRundeModal() {
  krevAdminMedDemo(
    erMix() ? 'Neste kamp' : 'Neste runde',
    erMix()
      ? 'Kun administrator kan gå videre. Nye lag trekkes automatisk.'
      : 'Kun administrator kan gå videre til neste runde. Skriv inn PIN-koden.',
    () => {
      const erSiste  = app.runde >= app.maksRunder;
      const tittelEl = document.getElementById('modal-neste-tittel');
      const tekstEl  = document.getElementById('modal-neste-tekst');
      const seBtn    = document.querySelector('#modal-neste .knapp-primaer');

      if (erMix()) {
        if (tittelEl) tittelEl.textContent = erSiste ? 'Avslutte Mix & Match?' : 'Neste kamp?';
        if (tekstEl)  tekstEl.textContent  = erSiste
          ? 'Siste kamp er ferdig! Vil du se hvem som scoret mest? 🎉'
          : `Kamp ${app.runde} er ferdig. Klar for nye lag? 🎲`;
        if (seBtn) seBtn.textContent = erSiste ? 'SE RESULTATER' : 'NYE LAG →';
      } else {
        if (tittelEl) tittelEl.textContent = 'Neste runde?';
        if (tekstEl)  tekstEl.textContent  = erSiste
          ? `Runde ${app.runde} er siste runde. Vil du se resultatene og avslutte økten?`
          : `Runde ${app.runde} av ${app.maksRunder} er ferdig. Vil du se rangeringer og forflytninger?`;
        if (seBtn) seBtn.textContent = 'SE RESULTATER';
      }

      document.getElementById('modal-neste').style.display = 'flex';
    }
  );
}
window.visNesteRundeModal = visNesteRundeModal;

function beregnSpillerstatistikk(spillere, kamper) {
  if (!spillere?.length || !kamper?.length) return [];
  const antall = spillere.length;
  const erSingelBaneStats = antall === 2;
  // Sjekk om kamp-dataene indikerer singel (erSingel-flagg i første kamp)
  const harSingelKamp = (kamper ?? []).some(k => k?.erSingel === true);
  const harDobbelKamp6 = app.er6SpillerFormat && !erSingelBaneStats && antall === 4;
  const parter = (erSingelBaneStats || harSingelKamp) ? PARTER_6_SINGEL : (harDobbelKamp6 ? PARTER_6_DOBBEL : getParter(antall));
  return spillere.map((spiller, si) => {
    let seire = 0, for_ = 0, imot = 0;
    parter.forEach(par => {
      const k = (kamper ?? []).find(k => k?.kampNr === par.nr);
      if (!k || k.lag1Poeng == null || k.lag2Poeng == null) return;

      // Singel: sammenlign med spillerId direkte
      if (erSingelBaneStats || k.erSingel) {
        const erL1 = k.lag1_s1 === spiller.id;
        const erL2 = k.lag2_s1 === spiller.id;
        if (!erL1 && !erL2) return;
        const mine  = erL1 ? k.lag1Poeng : k.lag2Poeng;
        const deres = erL1 ? k.lag2Poeng : k.lag1Poeng;
        if (mine > deres) seire++;
        for_ += mine; imot += deres;
        return;
      }

      // Hviler-sjekk: spiller er verken på lag1 eller lag2
      const paaL1  = par.lag1.includes(si);
      const paaL2  = par.lag2.includes(si);
      const hviler = par.hviler === si;

      if (hviler) {
        // Hvilende spiller får snittpoeng (Math.ceil av totalen)
        const hvilPoeng = k.hvilerPoeng ?? Math.ceil((k.lag1Poeng + k.lag2Poeng) / 2);
        for_ += hvilPoeng;
        // Ingen seir/tap for hvilende spiller
        return;
      }
      if (!paaL1 && !paaL2) return;

      const mine  = paaL1 ? k.lag1Poeng : k.lag2Poeng;
      const deres = paaL1 ? k.lag2Poeng : k.lag1Poeng;
      if (mine > deres) seire++;
      for_ += mine; imot += deres;
    });
    return {
      spillerId: spiller.id,
      navn:      spiller.navn ?? 'Ukjent',
      seire, for: for_, imot, diff: for_ - imot,
    };
  });
}

function sorterRangering(stats) {
  if (!stats?.length) return [];
  return [...stats]
    .sort((a, b) => b.seire - a.seire || b.diff - a.diff || b.for - a.for || (b.rating ?? STARTRATING) - (a.rating ?? STARTRATING))
    .map((s, i) => ({ ...s, baneRang: i + 1 }));
}

async function visRundeResultat() {
  document.getElementById('modal-neste').style.display = 'none';
  const erSiste = app.runde >= app.maksRunder;

  // Mix: hent alle kamper fra hele økten (akkumulert statistikk)
  // Konkurranse: kun gjeldende runde
  let kamperFraDB = Object.values(kampStatusCache);
  try {
    if (db && app.treningId) {
      const q = erMix()
        ? query(collection(db, SAM.KAMPER), where('treningId', '==', app.treningId))
        : query(collection(db, SAM.KAMPER), where('treningId', '==', app.treningId), where('rundeNr', '==', app.runde));
      const snap = await getDocs(q);
      if (!snap.empty) {
        kamperFraDB = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      }
    }
  } catch (e) {
    console.warn('[visRundeResultat] Kunne ikke hente kamper fra DB, bruker cache:', e?.message ?? e);
  }

  app.rangerteBAner = (app.baneOversikt ?? []).map(bane => {
    const kamper = kamperFraDB.filter(k => k?.baneNr === `bane${bane.baneNr}`);
    const stats  = beregnSpillerstatistikk(bane.spillere ?? [], kamper);
    return { baneNr: bane.baneNr, rangert: sorterRangering(stats), spillere: bane.spillere ?? [], erSingel: bane.erSingel ?? false };
  });

  // ── Forflytningsmerker ────────────────────────────────────────────────────
  // KONKURRANSE : opprykk/nedrykk beregnes og vises på ikke-siste runder
  // MIX         : ingen forflytning — alle stokkes om uansett
  const forflytninger = (!erSiste && !erMix()) ? beregnForflytninger(app.rangerteBAner) : {};
  const nestKnapp = document.getElementById('neste-runde-resultat-knapp');
  nestKnapp.textContent = erSiste ? 'AVSLUTT ØKT' : (erMix() ? 'NYE LAG →' : 'NESTE RUNDE →');
  nestKnapp.onclick     = erSiste ? visAvsluttModal : () => krevAdminMedDemo('Neste kamp', 'Kun administrator kan starte neste kamp. Skriv inn PIN-koden.', bekreftNesteRunde);

  // Mix: Kamp X resultat / konkurranse: Runde X resultat
  document.getElementById('res-runde-nummer').textContent = app.runde;
  const resultatAppName = document.querySelector('#skjerm-resultat .app-name');
  if (resultatAppName) {
    resultatAppName.innerHTML = erMix()
      ? `Kamp <span id="res-runde-nummer">${app.runde}</span> resultat`
      : `Runde <span id="res-runde-nummer">${app.runde}</span> resultat`;
  }

  const resultatSub = document.getElementById('resultat-hdr-sub');
  if (resultatSub) {
    resultatSub.textContent = erMix()
      ? (erSiste ? 'Takk for spillet! 🎉' : 'Hvem scoret mest?')
      : 'Rangering og forflytning';
  }

  document.getElementById('res-runde-nummer').textContent = app.runde;

  if (erMix()) {
    // ── MIX: Akkumuler statistikk direkte fra alle kamper i økten ────────
    // Slår opp spillerId direkte i kampdata — uavhengig av baneplassering
    const totaler = {};
    kamperFraDB
      .filter(k => k.ferdig && k.lag1Poeng != null && k.lag2Poeng != null)
      .forEach(k => {
        const lag1Vant = k.lag1Poeng > k.lag2Poeng;
        const lag2Vant = k.lag2Poeng > k.lag1Poeng;
        const leggTil = (id, navn, mine, deres, vant) => {
          if (!id) return;
          if (!totaler[id]) totaler[id] = { spillerId: id, navn: navn ?? 'Ukjent', seire: 0, for: 0, imot: 0 };
          totaler[id].for   += mine;
          totaler[id].imot  += deres;
          if (vant) totaler[id].seire += 1;
        };
        leggTil(k.lag1_s1, k.lag1_s1_navn, k.lag1Poeng, k.lag2Poeng, lag1Vant);
        leggTil(k.lag1_s2, k.lag1_s2_navn, k.lag1Poeng, k.lag2Poeng, lag1Vant);
        leggTil(k.lag2_s1, k.lag2_s1_navn, k.lag2Poeng, k.lag1Poeng, lag2Vant);
        leggTil(k.lag2_s2, k.lag2_s2_navn, k.lag2Poeng, k.lag1Poeng, lag2Vant);
        // Hvilende spiller (5-spillerbane) får snittpoeng, ingen seir
        if (k.hviler_id) {
          const hvilPoeng = k.hvilerPoeng ?? Math.ceil((k.lag1Poeng + k.lag2Poeng) / 2);
          if (!totaler[k.hviler_id]) totaler[k.hviler_id] = { spillerId: k.hviler_id, navn: k.hviler_navn ?? 'Ukjent', seire: 0, for: 0, imot: 0 };
          totaler[k.hviler_id].for += hvilPoeng;
        }
      });

    const alleSpillere = Object.values(totaler)
      .sort((a, b) => b.for - a.for || b.seire - a.seire || (b.for - b.imot) - (a.for - a.imot));

    const kampLabel = erSiste ? `Alle ${app.runde} kamper` : `Etter kamp ${app.runde}`;
    const mixNesteInfo = !erSiste
      ? `<div class="mix-neste-info">🎲 Nye lag trekkes til neste kamp</div>`
      : '';

    const rader = alleSpillere.map((s, i) => {
      const rkl = ['rn-1','rn-2','rn-3','rn-4'][i] ?? '';
      return `<div class="rang-rad">
        <div class="rang-nummer ${rkl}">${i + 1}</div>
        <div class="rang-navn">${escHtml(s.navn)}</div>
        <div class="rang-statistikk">${s.seire}S +${s.for}−${s.imot}</div>
      </div>`;
    }).join('');

    document.getElementById('resultat-innhold').innerHTML = `
      <div class="kort">
        <div class="kort-hode">
          <div style="font-family:'Bebas Neue',cursive;font-size:20px;letter-spacing:1px;color:var(--green2)">
            🎲 ${kampLabel}
          </div>
        </div>
        <div class="kort-innhold">${rader}${mixNesteInfo}</div>
      </div>`;

  } else {
    // ── KONKURRANSE: Rangering per bane med opprykk/nedrykk ─────────────
    document.getElementById('resultat-innhold').innerHTML = (app.rangerteBAner ?? []).map(bane => {
      if (!bane?.rangert?.length) return '';
      const erForst = bane.baneNr === 1;
      const erSistB = bane.baneNr === app.antallBaner;
      const er5bane = (bane.spillere?.length ?? 0) === 5;

      const rader = bane.rangert.map((s, ri) => {
        const fm  = forflytninger[s.spillerId] ?? 'blir';
        let merke = '<span class="forflytning-merke fm-blir">→ Blir</span>';
        if (fm === 'opp')     merke = '<span class="forflytning-merke fm-opp">↑ Opp</span>';
        if (fm === 'ned')     merke = '<span class="forflytning-merke fm-ned">↓ Ned</span>';
        if (fm === 'ut')      merke = '<span class="forflytning-merke fm-ut">→ Venteliste</span>';
        if (fm === 'roterer') merke = '<span class="forflytning-merke fm-blir">↻ Roterer</span>';
        if (erSiste)          merke = '';
        const rkl           = ['rn-1','rn-2','rn-3','rn-4','rn-4'][ri] ?? '';
        const spillerData   = (bane.spillere ?? []).find(sp => sp.id === s.spillerId);
        const spillerRating = spillerData?.rating ?? STARTRATING;
        const nivaaKlRang   = getNivaaKlasse(spillerRating);
        return `<div class="rang-rad ${nivaaKlRang}">
          <div class="rang-nummer ${rkl}">${ri + 1}</div>
          <div class="rang-navn">${escHtml(s.navn ?? 'Ukjent')}</div>
          <div class="rang-statistikk">${s.seire}S +${s.for}−${s.imot}</div>
          ${merke}
        </div>`;
      }).join('');

      const bane5merke     = er5bane ? `<span style="font-size:12px;background:rgba(234,88,12,.15);color:var(--orange);border-radius:4px;padding:2px 7px;font-weight:700">5 SPL</span>` : '';
      const singelMerkeRes = bane.erSingel ? `<span style="font-size:12px;background:rgba(234,179,8,.15);color:var(--yellow);border-radius:4px;padding:2px 7px;font-weight:700">🏃 SINGEL</span>` : (app.er6SpillerFormat ? `<span style="font-size:12px;background:rgba(37,99,235,.15);color:var(--accent2);border-radius:4px;padding:2px 7px;font-weight:700">🎾 DOBBEL</span>` : '');
      const baneIkon       = erForst && !bane.erSingel ? '🏆' : erSistB && !app.er6SpillerFormat ? '🔻' : '';
      const baneNummerFarge = bane.erSingel ? 'var(--yellow)' : 'var(--accent)';

      return `<div class="kort">
        <div class="kort-hode">
          <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
            <span style="font-family:'Bebas Neue',cursive;font-size:39px;color:${baneNummerFarge};line-height:1">${bane.baneNr}</span>
            <span style="font-size:14px;text-transform:uppercase;color:var(--muted2);letter-spacing:1.5px">Bane ${baneIkon}</span>
            ${bane5merke}${singelMerkeRes}
          </div>
        </div>
        <div class="kort-innhold">${rader}</div>
      </div>`;
    }).join('');
  }
  naviger('resultat');
}
window.visRundeResultat = visRundeResultat;

function beregnForflytninger(rangerteBAner) {
  if (!rangerteBAner?.length) return {};

  // 6-spiller-format: ingen forfremmelse/degradering — alle roterer automatisk
  if (app.er6SpillerFormat) {
    const mv = {};
    rangerteBAner.forEach(bane => {
      (bane.rangert ?? []).forEach(s => { mv[s.spillerId] = 'roterer'; });
    });
    return mv;
  }

  const n  = rangerteBAner.length;
  const mv = {};
  if (n === 1) {
    (rangerteBAner[0]?.rangert ?? []).forEach(s => { mv[s.spillerId] = 'blir'; });
    return mv;
  }
  rangerteBAner.forEach((bane, i) => {
    const r    = bane?.rangert ?? [];
    const sist = r.length - 1; // 3 for 4-bane, 4 for 5-bane
    if (r.length < 4) return;
    r.forEach(s => { mv[s.spillerId] = 'blir'; });
    if (i > 0 && i < n-1)  { mv[r[0].spillerId] = 'opp'; mv[r[sist].spillerId] = 'ned'; }
    else if (i === 0)       { mv[r[sist].spillerId] = 'ned'; }
    else {
      mv[r[0].spillerId] = 'opp';
      if ((app.venteliste ?? []).length > 0) mv[r[sist].spillerId] = 'ut';
    }
  });
  return mv;
}

async function bekreftNesteRunde() {
  if (!db || !app.treningId) { visMelding('Økt ikke aktiv.', 'feil'); return; }
  const n = app.rangerteBAner.length;
  if (n === 0) { visMelding('Ingen baner å flytte.', 'advarsel'); return; }

  lasUI('Starter neste runde…');
  startFailSafe(async () => { await updateDoc(doc(db, SAM.TRENINGER, app.treningId), { laast: false }); });

  try {
    await lassTrening(app.runde);
    const nyRunde = app.runde + 1;

    // ══════════════════════════════════════════
    // MIX & MATCH — smart ny lagfordeling
    // Ingen opprykk/nedrykk, ingen rating-hensyn.
    // Bruker spillehistorikk og hvile-historikk for rettferdig rotasjon.
    // ══════════════════════════════════════════
    if (erMix()) {
      // Hent oppdatert statistikk fra Firestore
      const { data: treningData } = await hentTrening();
      const { playedWith, playedAgainst, gamesPlayed, sitOutCount, lastSitOutRunde } =
        hentMixStatistikk(treningData);

      // Oppdater statistikk med kampene og hvile-runden som nettopp ble spilt
      const gjeldBaneOversikt = app.baneOversikt ?? [];
      const forrigeHvilere    = app.venteliste   ?? [];
      oppdaterMixStatistikk(
        gjeldBaneOversikt, forrigeHvilere,
        playedWith, playedAgainst, gamesPlayed,
        sitOutCount, lastSitOutRunde,
        app.runde
      );

      // Alle spillere i rotasjonen
      const alleSpillere = [
        ...(app.baneOversikt ?? []).flatMap(b => b.spillere ?? []),
        ...forrigeHvilere,
      ];

      let nyBaneOversikt, nyVenteliste = [];
      const mp = app.poengPerKamp ?? 15;

      // 6-spiller mix: tilfeldig ny dobbel + singel fordeling
      if (app.er6SpillerFormat) {
        const blandede = blandArray([...alleSpillere]);
        const dblSpl = blandede.slice(0, 4).map(s => ({ id: s.id, navn: s.navn ?? 'Ukjent', rating: s.rating ?? STARTRATING }));
        const sinSpl = blandede.slice(4, 6).map(s => ({ id: s.id, navn: s.navn ?? 'Ukjent', rating: s.rating ?? STARTRATING }));
        nyBaneOversikt = [
          { baneNr: 1, erDobbel: true,  erSingel: false, maksPoeng: mp, spillere: dblSpl },
          { baneNr: 2, erDobbel: false, erSingel: true,  maksPoeng: mp, spillere: sinSpl },
        ];
      } else {
        const resultat = lagMixKampoppsett(
          alleSpillere,
          playedWith, playedAgainst, gamesPlayed,
          sitOutCount, lastSitOutRunde,
          app.baneOversikt.length,
          nyRunde,
          mp
        );
        nyBaneOversikt = resultat.baneOversikt;
        nyVenteliste   = resultat.hviler ?? [];
      }

      const batch = writeBatch(db);
      batch.update(doc(db, SAM.TRENINGER, app.treningId), {
        gjeldendRunde:       nyRunde,
        baneOversikt:        nyBaneOversikt,
        venteliste:          nyVenteliste,
        laast:               false,
        // Lagre all oppdatert statistikk til Firestore
        mixPlayedWith:       playedWith,
        mixPlayedAgainst:    playedAgainst,
        mixGamesPlayed:      gamesPlayed,
        mixSitOutCount:      sitOutCount,
        mixLastSitOutRunde:  lastSitOutRunde,
      });
      // Mix: én kamp per bane per runde — lagene er allerede trukket i nyBaneOversikt
      skrivMixKamper(batch, app.treningId, nyRunde, nyBaneOversikt);
      await batch.commit();

      app.runde        = nyRunde;
      app.baneOversikt = nyBaneOversikt;
      app.venteliste   = nyVenteliste;
      kampStatusCache  = {};
      oppdaterRundeUI();
      startKampLytter();
      naviger('baner');
      visMelding('Runde ' + nyRunde + ' startet — nye lag!');
      return;
    }

    // ══════════════════════════════════════════
    // KONKURRANSE — 6-spiller rotasjon og standard opprykk/nedrykk
    // ══════════════════════════════════════════
    if (app.er6SpillerFormat) {
      const mp       = app.poengPerKamp ?? 15;
      const gjeldBane1 = (app.baneOversikt ?? []).find(b => b.baneNr === 1);
      const gjeldBane2 = (app.baneOversikt ?? []).find(b => b.baneNr === 2);

      if (!gjeldBane1 || !gjeldBane2) throw new Error('Kunne ikke finne bane 1 og 2.');

      // ── Les kampresultat fra dobbelkampen (bane 1, kamp 1) ──
      const dobbelKampData = kampStatusCache['bane1_1'];
      if (!dobbelKampData?.ferdig) {
        visMelding('Dobbel-kampen på bane 1 er ikke ferdig ennå.', 'advarsel');
        await lossTrening();
        return;
      }

      // Rekonstruer lag-objekter fra baneOversikt (spillere i fast rekkefølge)
      // lag1_s1/lag1_s2 lagrer IDs — matche mot spillerobjekter i baneOversikt
      const finnSpiller = (id) => gjeldBane1.spillere.find(s => s.id === id);
      const lag1 = [finnSpiller(dobbelKampData.lag1_s1), finnSpiller(dobbelKampData.lag1_s2)].filter(Boolean);
      const lag2 = [finnSpiller(dobbelKampData.lag2_s1), finnSpiller(dobbelKampData.lag2_s2)].filter(Boolean);

      if (lag1.length < 2 || lag2.length < 2) throw new Error('Kunne ikke rekonstruere lag fra kampdata.');

      const vinnerId = dobbelKampData.lag1Poeng > dobbelKampData.lag2Poeng ? 1
                     : dobbelKampData.lag2Poeng > dobbelKampData.lag1Poeng ? 2
                     : 1; // uavgjort: lag1 som vinner (arbitrært)

      const singelSpillere = gjeldBane2.spillere;

      // Kjør rotasjonslogikken
      const { dobbelLag1, dobbelLag2, singelPar } = neste6SpillerRunde(
        { lag1, lag2, vinnerId },
        singelSpillere
      );

      // Bygg baneOversikt — spillere i lag-rekkefølge (lag1 først, lag2 sist)
      const baneOversikt = [
        {
          baneNr: 1, erDobbel: true, erSingel: false,
          maksPoeng: gjeldBane1.maksPoeng ?? mp,
          spillere: [...dobbelLag1, ...dobbelLag2].map(s => ({
            id: s.id, navn: s.navn ?? 'Ukjent', rating: s.rating ?? STARTRATING,
          })),
        },
        {
          baneNr: 2, erDobbel: false, erSingel: true,
          maksPoeng: gjeldBane2.maksPoeng ?? mp,
          spillere: singelPar.map(s => ({
            id: s.id, navn: s.navn ?? 'Ukjent', rating: s.rating ?? STARTRATING,
          })),
        },
      ];

      const batch = writeBatch(db);
      batch.update(doc(db, SAM.TRENINGER, app.treningId), {
        gjeldendRunde: nyRunde,
        baneOversikt,
        venteliste:    [],
        laast:         false,
      });
      baneOversikt.forEach(bane =>
        skrivKamper(batch, app.treningId, nyRunde, bane.baneNr, bane.spillere, bane.erSingel ?? false, bane.erDobbel ?? false)
      );
      await batch.commit();

      app.runde        = nyRunde;
      app.baneOversikt = baneOversikt;
      app.venteliste   = [];
      kampStatusCache  = {};
      oppdaterRundeUI();
      startKampLytter();
      naviger('baner');
      visMelding('Runde ' + nyRunde + ' startet!');
      return;
    }

    // ══════════════════════════════════════════
    // STANDARD AMERICANO — forfremmelse/degradering
    // ══════════════════════════════════════════

    // Behold midtsjiktet (alle unntatt topp og bunn) fra forrige runde
    const neste = app.rangerteBAner.map(b => {
      // Hent maksPoeng fra gjeldende baneOversikt så det ikke mistes ved ny runde
      const gjeldendeBane = (app.baneOversikt ?? []).find(ob => ob.baneNr === b.baneNr);
      return {
        baneNr:    b.baneNr,
        maksPoeng: gjeldendeBane?.maksPoeng ?? (app.poengPerKamp ?? 17),
        // For 4-spillerbane: behold plass 2 og 3 (index 1,2)
        // For 5-spillerbane: behold plass 2, 3 og 4 (index 1,2,3)
        spillere: (b.rangert ?? [])
          .filter((_, ri) => ri > 0 && ri < (b.rangert.length - 1))
          .map(r => (b.spillere ?? []).find(s => s.id === r.spillerId))
          .filter(Boolean),
      };
    });

    const nyVenteliste = [...(app.venteliste ?? [])];

    for (let i = 0; i < app.rangerteBAner.length; i++) {
      const bane    = app.rangerteBAner[i];
      const r       = bane?.rangert ?? [];
      if (r.length < 4) continue;
      const sist    = r.length - 1;
      const finn    = (rang) => (bane.spillere ?? []).find(s => s.id === r[rang]?.spillerId);
      const erForst = i === 0;
      const erSist  = i === n - 1;

      if (n === 1) {
        // Én bane: topp og bunn blir — evt. bytt siste mot venteliste
        const topp = finn(0); if (topp) neste[0].spillere.push(topp);
        if (nyVenteliste.length > 0) {
          const inn = nyVenteliste.shift();
          if (inn) neste[0].spillere.push(inn);
          const bunn = finn(sist); if (bunn) nyVenteliste.push(bunn);
        } else {
          const bunn = finn(sist); if (bunn) neste[0].spillere.push(bunn);
        }
      } else if (!erForst && !erSist) {
        const opp = finn(0);    if (opp) neste[i-1].spillere.push(opp);
        const ned = finn(sist); if (ned) neste[i+1].spillere.push(ned);
      } else if (erForst) {
        const opp = finn(0); if (opp) neste[0].spillere.push(opp);
        if (n > 1) { const ned = finn(sist); if (ned) neste[1].spillere.push(ned); }
      } else {
        if (n > 1) { const opp = finn(0); if (opp) neste[n-2].spillere.push(opp); }
        if (nyVenteliste.length > 0) {
          const inn = nyVenteliste.shift();
          if (inn) neste[n-1].spillere.push(inn);
          const ut = finn(sist); if (ut) nyVenteliste.push(ut);
        } else {
          const ned = finn(sist); if (ned) neste[n-1].spillere.push(ned);
        }
      }
    }

    // Valider at alle baner har 4 eller 5 spillere — stopp hvis ikke
    const ugyldigBaneNeste = neste.find(b => b.spillere.length < 4 || b.spillere.length > 5);
    if (ugyldigBaneNeste) {
      throw new Error(
        `Bane ${ugyldigBaneNeste.baneNr} fikk ${ugyldigBaneNeste.spillere.length} spillere etter forflytning. ` +
        `Kontroller at antall spillere er delelig med 4 (eller gir 5-spillerbaner).`
      );
    }

    const baneOversikt = neste.map(b => ({
      baneNr:    b.baneNr,
      maksPoeng: b.maksPoeng, // bevares fra runde til runde
      spillere:  b.spillere.filter(Boolean).map(s => ({
        id: s.id, navn: s.navn ?? 'Ukjent', rating: s.rating ?? STARTRATING,
      })),
    }));

    const batch = writeBatch(db);
    batch.update(doc(db, SAM.TRENINGER, app.treningId), {
      gjeldendRunde: nyRunde,
      baneOversikt,
      venteliste: nyVenteliste,
      laast: false,
    });
    baneOversikt.forEach(bane =>
      skrivKamper(batch, app.treningId, nyRunde, bane.baneNr, bane.spillere, false, false)
    );
    await batch.commit();

    app.runde        = nyRunde;
    app.baneOversikt = baneOversikt;
    app.venteliste   = nyVenteliste;
    kampStatusCache  = {};
    oppdaterRundeUI();
    startKampLytter();
    naviger('baner');
    visMelding('Runde ' + nyRunde + ' startet!');
  } catch (e) {
    console.error('[bekreftNesteRunde]', e);
    visMelding(e?.message ?? 'Feil ved neste runde.', 'feil');
    if (!e?.message?.includes('jobber akkurat nå') && !e?.message?.includes('oppdatert av en annen')) {
      await lossTrening();
    }
  } finally {
    stoppFailSafe();
    frigiUI();
  }
}
window.bekreftNesteRunde = bekreftNesteRunde;

// ════════════════════════════════════════════════════════
// AVSLUTT ØKT — PIN-BESKYTTET
// ════════════════════════════════════════════════════════
function visAvsluttModal() {
  krevAdminMedDemo(
    'Avslutt økt',
    erMix()
      ? 'Kun administrator kan avslutte Mix & Match-økten.'
      : 'Kun administrator kan avslutte økten og oppdatere ratingene. Skriv inn PIN-koden.',
    () => {
      // Oppdater modal-tekst basert på modus
      const tekstEl = document.getElementById('modal-avslutt-tekst');
      if (tekstEl) {
        tekstEl.textContent = erMix()
          ? 'Dette avslutter Mix & Match-økten og beregner sluttrangeringen. Ingen ratingendringer.'
          : 'Dette beregner sluttrangeringen og oppdaterer alle spilleres rating. Kan ikke angres.';
      }
      document.getElementById('modal-avslutt').style.display = 'flex';
    }
  );
}
window.visAvsluttModal = visAvsluttModal;

async function avsluttTreningUI() {
  if (!db || !app.treningId) { visMelding('Økt ikke aktiv.', 'feil'); return; }
  document.getElementById('modal-avslutt').style.display = 'none';
  document.getElementById('modal-neste').style.display   = 'none';

  lasUI('Avslutter økt…');
  startFailSafe(async () => { await updateDoc(doc(db, SAM.TRENINGER, app.treningId), { laast: false }); });

  try {
    // Lås treningsdokumentet — forhindrer at to admin-er avslutter samtidig
    // Rundekonflikt-sjekk ikke nødvendig her (avslutning er alltid gyldig)
    await lassTrening(null);

    // ── Hent ALLE kamper for hele økten (alle runder) ────
    // Elo beregnes per kamp sekvensielt, så vi trenger alle runder.
    const kamperSnap = await getDocs(
      query(collection(db, SAM.KAMPER),
        where('treningId', '==', app.treningId)
      )
    );
    const alleKamper = kamperSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Finn alle fullførte runder (kamper med registrerte poeng).
    // Beskytter mot runder som er satt opp men ikke spilt.
    const harPoeng = k => k != null && k.lag1Poeng != null && k.lag2Poeng != null;
    const alleKamperMedPoeng = alleKamper.filter(harPoeng);

    if (alleKamperMedPoeng.length === 0) {
      visMelding('Ingen kamper med registrerte poeng funnet. Sjekk at poeng er registrert.', 'advarsel');
      await lossTrening();
      return;
    }

    // ── Beregn sluttrangering på tvers av ALLE fullførte runder ──────────
    // En runde regnes som fullført kun hvis ALLE kampene i runden har registrerte poeng.
    const alleRunder = [...new Set(alleKamper.map(k => k.rundeNr))];
    const fullforteRunder = alleRunder
      .filter(rundeNr => {
        const kamperIRunde = alleKamper.filter(k => k.rundeNr === rundeNr);
        return kamperIRunde.length > 0 && kamperIRunde.every(harPoeng);
      })
      .sort((a, b) => a - b);

    const baneNrListe = [...new Set(alleKamper
      .filter(k => fullforteRunder.includes(k.rundeNr))
      .map(k => k.baneNr))].sort();
    const spillerTotaler = {};

    // Beregn statistikk direkte fra kamp-dokumentene ved å matche spillerId mot lag1/lag2.
    // Dette unngår avhengighet av PARTER-indekser og er alltid korrekt uansett spillerrekkefølge.
    fullforteRunder.forEach(rundeNr => {
      const kamperIRunde = alleKamper.filter(k => k.rundeNr === rundeNr && harPoeng(k));
      kamperIRunde.forEach(kamp => {
        // Hent alle spillere i denne kampen med id og navn
        const lag1 = [
          kamp.lag1_s1 ? { id: kamp.lag1_s1, navn: kamp.lag1_s1_navn ?? 'Ukjent', lag: 1 } : null,
          kamp.lag1_s2 ? { id: kamp.lag1_s2, navn: kamp.lag1_s2_navn ?? 'Ukjent', lag: 1 } : null,
        ].filter(Boolean);
        const lag2 = [
          kamp.lag2_s1 ? { id: kamp.lag2_s1, navn: kamp.lag2_s1_navn ?? 'Ukjent', lag: 2 } : null,
          kamp.lag2_s2 ? { id: kamp.lag2_s2, navn: kamp.lag2_s2_navn ?? 'Ukjent', lag: 2 } : null,
        ].filter(Boolean);

        const lag1Vant = kamp.lag1Poeng > kamp.lag2Poeng;
        const lag2Vant = kamp.lag2Poeng > kamp.lag1Poeng;

        [...lag1, ...lag2].forEach(spiller => {
          if (!spiller?.id) return;
          if (!spillerTotaler[spiller.id]) {
            spillerTotaler[spiller.id] = { spillerId: spiller.id, navn: spiller.navn, seire: 0, kamper: 0, for: 0, imot: 0, diff: 0 };
          }
          const erLag1 = spiller.lag === 1;
          const mine  = erLag1 ? kamp.lag1Poeng : kamp.lag2Poeng;
          const deres = erLag1 ? kamp.lag2Poeng : kamp.lag1Poeng;
          if ((erLag1 && lag1Vant) || (!erLag1 && lag2Vant)) {
            spillerTotaler[spiller.id].seire += 1;
          }
          spillerTotaler[spiller.id].kamper += 1;
          spillerTotaler[spiller.id].for    += mine;
          spillerTotaler[spiller.id].imot   += deres;
          spillerTotaler[spiller.id].diff   += mine - deres;
        });

        // Hvilende spiller får snittpoeng men ingen seir
        if (kamp.hviler_id) {
          if (!spillerTotaler[kamp.hviler_id]) {
            spillerTotaler[kamp.hviler_id] = { spillerId: kamp.hviler_id, navn: kamp.hviler_navn ?? 'Ukjent', seire: 0, for: 0, imot: 0, diff: 0 };
          }
          const hvilPoeng = kamp.hvilerPoeng ?? Math.ceil((kamp.lag1Poeng + kamp.lag2Poeng) / 2);
          spillerTotaler[kamp.hviler_id].for  += hvilPoeng;
          spillerTotaler[kamp.hviler_id].diff += hvilPoeng;
        }
      });
    });

    // Sluttrangering:
    // KONKURRANSE — basert på SISTE fullførte runde (bane-plassering med opprykk/nedrykk)
    // MIX         — basert på AKKUMULERT statistikk fra alle fullførte runder

    let rangerteBAner;

    if (erMix()) {
      // Mix: sorter alle spillere etter total-statistikk på tvers av alle runder
      const alle = Object.values(spillerTotaler)
        .sort((a, b) => b.for - a.for || b.seire - a.seire || b.diff - a.diff || Math.random() - 0.5);
      rangerteBAner = [{ baneNr: 1, erSingel: false, rangert: alle.map((s, i) => ({ ...s, baneRang: i + 1 })) }];

    } else {
      // Konkurranse: bruk kun siste fullførte runde
      const sisteFullforteRunde = fullforteRunder[fullforteRunder.length - 1];
      const kamperSisteRunde = alleKamper.filter(k => k.rundeNr === sisteFullforteRunde && harPoeng(k));

      const sisteRundeTotaler = {};
      kamperSisteRunde.forEach(kamp => {
        const lag1 = [
          kamp.lag1_s1 ? { id: kamp.lag1_s1, navn: kamp.lag1_s1_navn ?? 'Ukjent', lag: 1 } : null,
          kamp.lag1_s2 ? { id: kamp.lag1_s2, navn: kamp.lag1_s2_navn ?? 'Ukjent', lag: 1 } : null,
        ].filter(Boolean);
        const lag2 = [
          kamp.lag2_s1 ? { id: kamp.lag2_s1, navn: kamp.lag2_s1_navn ?? 'Ukjent', lag: 2 } : null,
          kamp.lag2_s2 ? { id: kamp.lag2_s2, navn: kamp.lag2_s2_navn ?? 'Ukjent', lag: 2 } : null,
        ].filter(Boolean);
        const lag1Vant = kamp.lag1Poeng > kamp.lag2Poeng;
        const lag2Vant = kamp.lag2Poeng > kamp.lag1Poeng;
        [...lag1, ...lag2].forEach(spiller => {
          if (!spiller?.id) return;
          if (!sisteRundeTotaler[spiller.id]) {
            sisteRundeTotaler[spiller.id] = { spillerId: spiller.id, navn: spiller.navn, seire: 0, kamper: 0, for: 0, imot: 0, diff: 0 };
          }
          const erLag1 = spiller.lag === 1;
          const mine   = erLag1 ? kamp.lag1Poeng : kamp.lag2Poeng;
          const deres  = erLag1 ? kamp.lag2Poeng : kamp.lag1Poeng;
          if ((erLag1 && lag1Vant) || (!erLag1 && lag2Vant)) sisteRundeTotaler[spiller.id].seire += 1;
          sisteRundeTotaler[spiller.id].kamper += 1;
          sisteRundeTotaler[spiller.id].for    += mine;
          sisteRundeTotaler[spiller.id].imot   += deres;
          sisteRundeTotaler[spiller.id].diff   += mine - deres;
        });
      });

      const spillerTilBane = {};
      kamperSisteRunde.forEach(k => {
        const baneNrInt = parseInt((k.baneNr ?? '').replace('bane', '')) || 0;
        if (k.lag1_s1) spillerTilBane[k.lag1_s1] = baneNrInt;
        if (k.lag1_s2) spillerTilBane[k.lag1_s2] = baneNrInt;
        if (k.lag2_s1) spillerTilBane[k.lag2_s1] = baneNrInt;
        if (k.lag2_s2) spillerTilBane[k.lag2_s2] = baneNrInt;
      });

      const baneGrupper = {};
      Object.values(sisteRundeTotaler).forEach(s => {
        const baneNr = spillerTilBane[s.spillerId] ?? 1;
        if (!baneGrupper[baneNr]) baneGrupper[baneNr] = [];
        baneGrupper[baneNr].push(s);
      });

      rangerteBAner = Object.keys(baneGrupper)
        .map(Number)
        .sort((a, b) => a - b)
        .map(baneNr => ({
          baneNr,
          erSingel: false,
          rangert: baneGrupper[baneNr]
            .sort((a, b) => b.seire - a.seire || b.diff - a.diff || b.for - a.for)
            .map((s, i) => ({ ...s, baneRang: i + 1 })),
        }));
    }

    const tsSnap = await getDocs(
      query(collection(db, SAM.TS), where('treningId', '==', app.treningId))
    );
    const tsMap = {};
    (tsSnap?.docs ?? []).forEach(d => {
      const data = d.data() ?? {};
      if (data.spillerId) {
        tsMap[data.spillerId] = { docId: d.id, ratingVedStart: data.ratingVedStart ?? STARTRATING };
      }
    });

    const sluttrangering = (() => {
      // 6-spiller-format: ranger alle 6 spillere samlet på tvers av baner (dobbel + singel)
      if (app.er6SpillerFormat) {
        const alle = rangerteBAner.flatMap(bane =>
          (bane.rangert ?? []).map(s => ({
            ...s,
            ratingVedStart: tsMap[s.spillerId]?.ratingVedStart ?? STARTRATING,
          }))
        ).sort((a, b) => b.seire - a.seire || b.diff - a.diff || b.for - a.for);
        return alle.map((s, i) => ({ ...s, sluttPlassering: i + 1 }));
      }
      // Standard: bane-for-bane rangering
      let plassering = 1;
      return rangerteBAner
        .sort((a, b) => a.baneNr - b.baneNr)
        .flatMap(bane => {
          // Re-sorter med rating som tiebreaker nå som tsMap er tilgjengelig
          const resortert = [...(bane.rangert ?? [])].sort((a, b) =>
            b.seire - a.seire || b.diff - a.diff || b.for - a.for ||
            (tsMap[b.spillerId]?.ratingVedStart ?? STARTRATING) - (tsMap[a.spillerId]?.ratingVedStart ?? STARTRATING)
          );
          return resortert.map(s => {
            const rad = {
              ...s,
              sluttPlassering: plassering,
              ratingVedStart:  tsMap[s.spillerId]?.ratingVedStart ?? STARTRATING,
            };
            plassering++;
            return rad;
          });
        });
    })();

    if (sluttrangering.length === 0) {
      visMelding('Ingen sluttrangering tilgjengelig. Sjekk at alle poeng er registrert.', 'advarsel');
      await lossTrening();
      return;
    }

    // ── Elo-ratingberegning ───────────────────────────────────────────────
    // KONKURRANSE : Elo beregnes per kamp og skrives tilbake til spillerprofil
    // MIX         : Ingen ratingendring — spillerens rating forblir uendret

    const spillereListe = sluttrangering.map(s => ({
      id:     s.spillerId,
      rating: tsMap[s.spillerId]?.ratingVedStart ?? STARTRATING,
    }));

    const eloResultat = erMix() ? {} : beregnEloForOkt(alleKamper, spillereListe);

    app.ratingEndringer = sluttrangering.map(s => {
      if (erMix()) {
        const startRating  = tsMap[s.spillerId]?.ratingVedStart ?? STARTRATING;
        const antallKamper = s.kamper ?? 0;   // talt direkte fra kampdata
        return { ...s, ratingVedStart: startRating, endring: 0, nyRating: startRating, antallKamper };
      }
      const elo = eloResultat[s.spillerId] ?? { startRating: STARTRATING, nyRating: STARTRATING, endring: 0 };
      return { ...s, ratingVedStart: elo.startRating, endring: elo.endring, nyRating: elo.nyRating, antallKamper: 0 };
    });

    // ── Skriv alt til Firestore atomisk ──────────────────────────────────
    // KONKURRANSE : oppdaterer rating, lagrer historikk og resultater
    // MIX         : lagrer kun plassering — ingen rating- eller historikkskriving
    const batch = writeBatch(db);
    app.ratingEndringer.forEach(r => {
      if (!r.spillerId) return;

      // Konkurranse: oppdater spillerens rating i databasen
      if (!erMix()) {
        batch.update(doc(db, SAM.SPILLERE, r.spillerId), { rating: r.nyRating });
      }

      // Begge moduser: lagre sluttresultat (plassering og poeng)
      batch.set(doc(collection(db, SAM.RESULTATER)), {
        treningId:     app.treningId,
        spillerId:     r.spillerId,
        spillerNavn:   r.navn ?? 'Ukjent',
        sluttPlassering: r.sluttPlassering,
        ratingFor:     r.ratingVedStart,
        ratingEtter:   r.nyRating,
        ratingEndring: r.endring,
        dato:          serverTimestamp(),
        spillModus:    app.spillModus,
        // Mix & Match: lagre poengstatistikk (brukes i resultatvisning)
        totalPoeng:    r.for          ?? 0,
        antallKamper:  r.antallKamper ?? 0,
        seire:         r.seire        ?? 0,
        imot:          r.imot         ?? 0,
      });

      // Konkurranse: lagre i ratinghistorikk (brukes i profilgraf)
      if (!erMix()) {
        batch.set(doc(collection(db, SAM.HISTORIKK)), {
          spillerId:   r.spillerId,
          treningId:   app.treningId,
          ratingFor:   r.ratingVedStart,
          ratingEtter: r.nyRating,
          endring:     r.endring,
          plassering:  r.sluttPlassering,
          dato:        serverTimestamp(),
        });
      }

      const tsDocId = tsMap[r.spillerId]?.docId;
      if (tsDocId) batch.update(doc(db, SAM.TS, tsDocId), { sluttPlassering: r.sluttPlassering });
    });
    // Marker som avsluttet og løs lås atomisk i samme batch
    batch.update(doc(db, SAM.TRENINGER, app.treningId), {
      status: 'avsluttet',
      avsluttetDato: serverTimestamp(),
      laast: false,
    });
    await batch.commit();

    sessionStorage.removeItem('aktivTreningId');
    try { history.replaceState(null, '', location.pathname); } catch (_) {}
    stoppLyttere();
    // Nullstill treningId slik at baner-skjermen viser tom tilstand
    // om bruker navigerer dit etter avslutning
    app.treningId    = null;
    app.baneOversikt = [];
    app.venteliste   = [];
    kampStatusCache  = {};
    setErAdmin(false); // nullstill admin-status ved avslutning
    naviger('slutt');
  } catch (e) {
    console.error('[avsluttTreningUI]', e);
    visMelding(e?.message ?? 'Feil ved avslutning.', 'feil');
    if (!e?.message?.includes('jobber akkurat nå')) {
      await lossTrening();
    }
  } finally {
    stoppFailSafe();
    frigiUI();
  }
}
window.avsluttTreningUI = avsluttTreningUI;

// ════════════════════════════════════════════════════════
// SLUTTRESULTAT
// ════════════════════════════════════════════════════════
async function visSluttresultat() {
  let data = app.ratingEndringer ?? [];

  if (!data.length && db) {
    document.getElementById('ledertavle').innerHTML =
      '<div style="padding:20px;text-align:center;color:var(--muted2)">Laster resultater…</div>';
    try {
      const treningId = app.treningId || sessionStorage.getItem('aktivTreningId');
      if (treningId) {
        const resSnap = await getDocs(
          query(collection(db, SAM.RESULTATER), where('treningId', '==', treningId))
        );
        data = resSnap.docs
          .map(d => d.data())
          .sort((a, b) => a.sluttPlassering - b.sluttPlassering)
          .map(r => ({
            spillerId:       r.spillerId,
            navn:            r.spillerNavn ?? 'Ukjent',
            sluttPlassering: r.sluttPlassering,
            nyRating:        r.ratingEtter,
            ratingVedStart:  r.ratingFor,
            endring:         r.ratingEndring,
            spillModus:      r.spillModus,
            // Mix-statistikk (lagres kun for mix-økter)
            for:             r.totalPoeng    ?? 0,
            antallKamper:    r.antallKamper  ?? 0,
            seire:           r.seire         ?? 0,
            imot:            r.imot          ?? 0,
          }));
      }
    } catch (e) {
      console.warn('[visSluttresultat] Kunne ikke hente fra Firestore:', e?.message ?? e);
    }
  }

  if (!data.length) {
    document.getElementById('ledertavle').innerHTML =
      '<div style="padding:20px;text-align:center;color:var(--muted2)">Ingen økt avsluttet ennå</div>';
    document.getElementById('rating-endringer').innerHTML = '';
    return;
  }

  // Bestem layout: mix-mode, lagret mix-økt, eller konkurranse
  const visMixLayout = erMix()
    || data[0]?.spillModus === 'mix'
    || data.every(s => s.endring === 0 && s.nyRating === s.ratingVedStart);

  if (visMixLayout) {
    visMixSluttresultat(data);
  } else {
    visKonkurranseSluttresultat(data);
  }
}

// ────────────────────────────────────────────────────────
// KONKURRANSE-SLUTTRESULTAT
// Rating, rangering og Elo-endringer per spiller.
// ────────────────────────────────────────────────────────
function visKonkurranseSluttresultat(data) {
  const mixBanner = document.getElementById('mix-slutt-banner');
  if (mixBanner) mixBanner.style.display = 'none';

  const sluttNavn = document.getElementById('slutt-hdr-navn');
  const sluttSub  = document.getElementById('slutt-hdr-sub');
  const ledLabel  = document.getElementById('slutt-ledertavle-label');
  if (sluttNavn) sluttNavn.textContent = 'Sluttresultat';
  if (sluttSub)  sluttSub.textContent  = 'Økten er ferdig';
  if (ledLabel)  ledLabel.textContent  = '🏆 Ledertavle';

  document.getElementById('ledertavle').innerHTML = data.map(s => {
    const ini = (s.navn ?? '?').split(' ').map(w => w[0] ?? '').join('').slice(0,2).toUpperCase() || '?';
    return `<div class="lb-rad" onclick="apneProfil('${s.spillerId}')">
      <div class="lb-plass${s.sluttPlassering <= 3 ? ' topp3' : ''}">${s.sluttPlassering}</div>
      <div class="lb-avatar">${ini}</div>
      <div class="lb-navn">${s.navn ?? 'Ukjent'}</div>
      <div style="text-align:right">
        <div style="font-family:'DM Mono',monospace;font-size:15px;color:var(--muted2)">${s.nyRating}</div>
        <div class="lb-endring ${s.endring >= 0 ? 'pos' : 'neg'}">${s.endring >= 0 ? '+' : ''}${s.endring}</div>
      </div>
    </div>`;
  }).join('');

  const ratingEl      = document.getElementById('rating-endringer');
  const ratingSection = [...document.querySelectorAll('.seksjon-etikett')]
    .find(el => el.textContent.includes('Ratingendringer'));
  if (ratingEl)      ratingEl.closest('.kort').style.display = '';
  if (ratingSection) ratingSection.style.display             = '';
  if (ratingEl) ratingEl.innerHTML = data.map(s => `
    <div class="lb-rad" style="cursor:default">
      <div style="flex:1;font-size:17px">${s.navn ?? 'Ukjent'}</div>
      <div style="font-family:'DM Mono',monospace;font-size:15px;color:var(--muted2);margin-right:10px">${s.ratingVedStart ?? STARTRATING} → ${s.nyRating}</div>
      <div class="lb-endring ${s.endring >= 0 ? 'pos' : 'neg'}">${s.endring >= 0 ? '+' : ''}${s.endring}</div>
    </div>`).join('');
}

// ────────────────────────────────────────────────────────
// MIX & MATCH — SLUTTRESULTAT
// Totalpoeng, antall kamper og positive utmerkelser.
// Ingen rating. Uformell, sosial tone.
// ────────────────────────────────────────────────────────
function visMixSluttresultat(data) {
  const mixBanner = document.getElementById('mix-slutt-banner');
  if (mixBanner) mixBanner.style.display = 'block';

  const sluttNavn = document.getElementById('slutt-hdr-navn');
  const sluttSub  = document.getElementById('slutt-hdr-sub');
  const ledLabel  = document.getElementById('slutt-ledertavle-label');
  if (sluttNavn) sluttNavn.textContent = 'Mix & Match';
  if (sluttSub)  sluttSub.textContent  = 'Takk for spillet!';
  if (ledLabel)  ledLabel.textContent  = '🎉 Øktoversikt';

  // Skjul konkurranse-seksjonene
  const ratingEl      = document.getElementById('rating-endringer');
  const ratingSection = [...document.querySelectorAll('.seksjon-etikett')]
    .find(el => el.textContent.includes('Ratingendringer'));
  if (ratingEl)      ratingEl.closest('.kort').style.display = 'none';
  if (ratingSection) ratingSection.style.display             = 'none';

  // ── Utmerkelser ───────────────────────────────────────────────
  // Sorter etter totalpoeng for å finne vinnerne
  const flerstPoengId  = [...data].sort((a, b) => (b.for ?? 0) - (a.for ?? 0))[0]?.spillerId;
  const flestKamperId  = [...data].sort((a, b) => (b.antallKamper ?? 0) - (a.antallKamper ?? 0))[0]?.spillerId;
  const flestSeireId   = [...data]
    .filter(s => (s.antallKamper ?? 0) > 0)
    .sort((a, b) => (b.seire ?? 0) - (a.seire ?? 0))[0]?.spillerId;

  // Sorter visning etter totalpoeng
  const sortert = [...data].sort((a, b) => (b.for ?? 0) - (a.for ?? 0));

  // Positive heiarop-tekster — veksler så ingen får samme
  const heiarop = [
    'Bra jobba! 👏', 'Fin innsats! ⚡', 'Godt spilt! 🎯',
    'Solid spilling! 💪', 'Bra innsats! 😄', 'Godt gjort! 🤝',
    'Strålende! ✨', 'Kjempebra! 🌟',
  ];

  document.getElementById('ledertavle').innerHTML = sortert.map((s, i) => {
    const ini          = (s.navn ?? '?').split(' ').map(w => w[0] ?? '').join('').slice(0,2).toUpperCase() || '?';
    const totalPoeng   = s.for          ?? 0;
    const antallKamper = s.antallKamper ?? 0;
    const seire        = s.seire        ?? 0;
    const winPst       = antallKamper > 0 ? Math.round((seire / antallKamper) * 100) : 0;

    // Utmerkelser for denne spilleren
    const utmerkelser = [];
    if (sortert.length > 1) {
      if (s.spillerId === flerstPoengId)  utmerkelser.push({ ikon: '🎖', tekst: 'Flest poeng' });
      if (s.spillerId === flestSeireId && s.spillerId !== flerstPoengId)
        utmerkelser.push({ ikon: '🔥', tekst: 'Flest seire' });
    }

    const erTopp = i === 0 && sortert.length > 1;
    const rosHTML = `<div class="mix-spiller-ros">${heiarop[i % heiarop.length]}</div>`;
    const utmerkelseHTML = utmerkelser.length
      ? `<div class="mix-utmerkelser">${utmerkelser.map(u => `<span class="mix-utmerkelse">${u.ikon} ${u.tekst}</span>`).join('')}</div>`
      : '';

    return `<div class="mix-spiller-kort${erTopp ? ' mix-spiller-kort-topp' : ''}">
      <div class="mix-spiller-hoved">
        <div class="mix-spiller-avatar${erTopp ? ' mix-spiller-avatar-topp' : ''}">${ini}</div>
        <div class="mix-spiller-meta">
          <div class="mix-spiller-navn">${escHtml(s.navn ?? 'Ukjent')}</div>
          ${rosHTML}${utmerkelseHTML}
        </div>
        <div class="mix-poeng-boks${erTopp ? ' mix-poeng-boks-topp' : ''}">
          <div class="mix-poeng-tal">${totalPoeng}</div>
          <div class="mix-poeng-lbl">poeng</div>
        </div>
      </div>
      <div class="mix-statistikk-rad">
        <div class="mix-stat-celle">
          <span class="mix-stat-verdi">${antallKamper}</span>
          <span class="mix-stat-lbl">kamper</span>
        </div>
        <div class="mix-stat-celle">
          <span class="mix-stat-verdi">${seire}</span>
          <span class="mix-stat-lbl">seire</span>
        </div>
        <div class="mix-stat-celle">
          <span class="mix-stat-verdi">${winPst}%</span>
          <span class="mix-stat-lbl">winrate</span>
        </div>
      </div>
    </div>`;
  }).join('');
}


// ════════════════════════════════════════════════════════
// SPILLERPROFIL
// ════════════════════════════════════════════════════════
let diagram = null;
async function apneProfil(spillerId) {
  if (!spillerId) return;
  const s = (app.ratingEndringer ?? []).find(x => x.spillerId === spillerId);
  if (!s) return;

  document.getElementById('profil-navn').textContent   = s.navn ?? 'Ukjent';
  document.getElementById('profil-rating').textContent = s.nyRating;
  document.getElementById('profil-statistikk').innerHTML = [
    { val: '#' + s.sluttPlassering,             lbl: 'Sluttplassering', farge: 'var(--white)' },
    { val: (s.endring >= 0 ? '+' : '') + s.endring, lbl: 'Ratingendring', farge: s.endring >= 0 ? 'var(--green2)' : 'var(--red2)' },
    { val: s.ratingVedStart ?? STARTRATING,      lbl: 'Rating før',      farge: 'var(--white)' },
  ].map(b => `<div class="stat-boks">
    <div class="stat-verdi" style="color:${b.farge}">${b.val}</div>
    <div class="stat-etikett">${b.lbl}</div>
  </div>`).join('');

  // Hent ratinghistorikk — spørring filtrert på klient (unngår composite index-krav)
  let historikk = [];
  try {
    if (db) {
      const snap = await getDocs(
        query(collection(db, SAM.HISTORIKK), where('spillerId', '==', spillerId))
      );
      historikk = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.dato?.toMillis?.() ?? 0) - (b.dato?.toMillis?.() ?? 0));
    }
  } catch (e) {
    console.warn('Kunne ikke hente historikk:', e?.message ?? e);
  }

  const ratingData = historikk.length ? historikk.map(h => h.ratingEtter ?? STARTRATING) : [s.ratingVedStart ?? STARTRATING, s.nyRating];
  const etiketter  = historikk.length ? historikk.map((_, i) => 'T' + (i+1)) : ['Start', 'Nå'];

  if (diagram) { try { diagram.destroy(); } catch (_) {} diagram = null; }
  const canvas = document.getElementById('rating-diagram');
  if (canvas) {
    diagram = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: etiketter,
        datasets: [{
          data: ratingData, borderColor: '#eab308',
          backgroundColor: 'rgba(234,179,8,0.08)', borderWidth: 2.5,
          pointRadius: 5, pointBackgroundColor: '#eab308',
          pointBorderColor: '#050f1f', pointBorderWidth: 2,
          tension: 0.35, fill: true,
        }],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 11 } } },
          y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 11 } } },
        },
      },
    });
  }

  document.getElementById('trening-historikk').innerHTML = historikk.length
    ? [...historikk].reverse().map((h, i) => `
        <div class="historikk-rad">
          <div style="flex:1">Økt ${historikk.length - i}</div>
          <div style="font-family:'DM Mono',monospace;font-size:14px;color:var(--muted2);margin-right:8px">Plass #${h.plassering ?? '—'}</div>
          <div style="font-family:'DM Mono',monospace;font-size:16px;font-weight:600;color:${(h.endring ?? 0) >= 0 ? 'var(--green2)' : 'var(--red2)'}">
            ${(h.endring ?? 0) >= 0 ? '+' : ''}${h.endring ?? 0}
          </div>
        </div>`).join('')
    : '<div style="padding:16px;text-align:center;font-size:16px;color:var(--muted2)">Ingen historikk ennå</div>';

  naviger('profil');
}
window.apneProfil = apneProfil;


// ════════════════════════════════════════════════════════
// GLOBAL LEDERTAVLE (Spillere-skjermen)
// ════════════════════════════════════════════════════════
function oppdaterGlobalLedertavle() {
  const laster = document.getElementById('global-laster');
  const liste  = document.getElementById('global-ledertavle');
  if (laster) laster.style.display = 'none';
  if (liste)  liste.innerHTML = '';
  try {
    const spillere = [...(app.spillere ?? [])].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    if (!spillere.length) {
      if (liste) liste.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted2);font-size:16px">Ingen spillere registrert ennå</div>';
      return;
    }
    if (liste) {
      liste.innerHTML = spillere.map((s, i) => {
        const plass = i + 1;
        const ini   = (s.navn ?? '?').split(' ').map(w => w[0] ?? '').join('').slice(0,2).toUpperCase() || '?';
        const nivaaKlLB = getNivaaKlasse(s.rating ?? STARTRATING);
        return `<div class="lb-rad ${nivaaKlLB}" onclick="apneGlobalProfil('${s.id}')" style="cursor:pointer">
          <div class="lb-plass${plass <= 3 ? ' topp3' : ''}">${plass}</div>
          <div class="lb-avatar">${ini}</div>
          <div class="lb-navn">${s.navn ?? 'Ukjent'}</div>
          <div style="text-align:right;flex-shrink:0">
            ${getNivaaRatingHTML(s.rating ?? STARTRATING)}
          </div>
        </div>`;
      }).join('');
    }

    // Fyll sammenlign-dropdowns med alle spillere
    const optioner = spillere.map(s =>
      `<option value="${s.id}">${escHtml(s.navn ?? 'Ukjent')} (${s.rating ?? STARTRATING})</option>`
    ).join('');
    ['sammenlign-s1','sammenlign-s2'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.innerHTML = '<option value="">— Velg spiller —</option>' + optioner;
      }
    });
    nullstillSammenligning();

    // Beregn sesongkåring asynkront — blokkerer ikke ratinglisten
    beregnSesongsKaaring(spillere);

  } catch (e) {
    visFBFeil('Kunne ikke vise ledertavle: ' + (e?.message ?? e));
  }
}
window.oppdaterGlobalLedertavle = oppdaterGlobalLedertavle;

// ════════════════════════════════════════════════════════
// SESONGKÅRING — Formspilleren og Beste partner
// ════════════════════════════════════════════════════════

// Minimum antall kamper for å telle i kåringen
const SESONG_MIN_KAMPER = 10;

let _sesongCache = null;
const SESONG_TTL_MS = 2 * 60 * 1000;

/**
 * Henter alle ferdigspilte kamper og beregner:
 *   1. Formspilleren  — høyest individuell overperformance
 *   2. Beste partner  — løfter flest lagkamerater over forventet nivå
 *
 * Overperformance per spiller per kamp:
 *   forventet = eloForventet(egetLagRating, motstanderLagRating)
 *   faktisk   = 1 (vant) | 0 (tapte) | 0.5 (uavgjort)
 *   bidrag    = faktisk - forventet
 *
 * Snitt av alle bidrag over alle kamper = overperformance-score.
 *
 * @param {Array} spillereListe  — [{ id, navn, rating }]
 */
async function beregnSesongsKaaring(spillereListe) {
  const sesongLaster = document.getElementById('sesong-laster');
  const sesongBoks   = document.getElementById('sesong-kaaring');

  if (_sesongCache && (Date.now() - _sesongCache.hentetMs) < SESONG_TTL_MS) {
    if (sesongBoks) { sesongBoks.innerHTML = _sesongCache.html; sesongBoks.style.display = 'block'; }
    if (sesongLaster) sesongLaster.style.display = 'none';
    return;
  }

  if (sesongLaster) sesongLaster.style.display = 'flex';
  if (sesongBoks)   sesongBoks.style.display   = 'none';

  try {
    // Hent alle ferdigspilte kamper i hele databasen
    const snap = await getDocs(query(
      collection(db, SAM.KAMPER),
      where('ferdig', '==', true)
    ));
    const alleKamper = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(k => k.lag1Poeng != null && k.lag2Poeng != null);

    if (alleKamper.length === 0) {
      if (sesongLaster) sesongLaster.style.display = 'none';
      return;
    }

    // Bygg rating-kart for rask oppslag
    const ratingMap = {};
    spillereListe.forEach(s => { ratingMap[s.id] = s.rating ?? STARTRATING; });

    // ── Per spiller: akkumuler overperformance-bidrag ──
    // overMap[spillerId] = { navn, bidragSum, kamper, partnerBidrag }
    // partnerBidrag[partnerId] = { bidragSum, kamper }  ← for beste-partner-beregning
    const overMap = {};

    const sikkerId = id => id && ratingMap[id] !== undefined;

    for (const k of alleKamper) {
      const erSingel = !k.lag1_s2 && !k.lag2_s2;
      if (!sikkerId(k.lag1_s1) || !sikkerId(k.lag2_s1)) continue;
      if (!erSingel && (!sikkerId(k.lag1_s2) || !sikkerId(k.lag2_s2))) continue;

      const rA = erSingel
        ? (ratingMap[k.lag1_s1])
        : (ratingMap[k.lag1_s1] + ratingMap[k.lag1_s2]) / 2;
      const rB = erSingel
        ? (ratingMap[k.lag2_s1])
        : (ratingMap[k.lag2_s1] + ratingMap[k.lag2_s2]) / 2;

      const forventetA = eloForventet(rA, rB);
      const forventetB = 1 - forventetA;

      const faktiskA = k.lag1Poeng > k.lag2Poeng ? 1 : k.lag1Poeng < k.lag2Poeng ? 0 : 0.5;
      const faktiskB = 1 - faktiskA;

      const lag1 = [{ id: k.lag1_s1, navn: k.lag1_s1_navn }, erSingel ? null : { id: k.lag1_s2, navn: k.lag1_s2_navn }].filter(Boolean);
      const lag2 = [{ id: k.lag2_s1, navn: k.lag2_s1_navn }, erSingel ? null : { id: k.lag2_s2, navn: k.lag2_s2_navn }].filter(Boolean);

      const registrer = (lagSpillere, faktisk, forventet) => {
        lagSpillere.forEach(sp => {
          if (!sp.id) return;
          if (!overMap[sp.id]) overMap[sp.id] = { navn: sp.navn ?? 'Ukjent', bidragSum: 0, kamper: 0, partnerBidrag: {} };
          overMap[sp.id].bidragSum += (faktisk - forventet);
          overMap[sp.id].kamper++;

          // Legg til partner-bidrag for den andre spilleren på laget
          const partner = lagSpillere.find(p => p.id !== sp.id);
          if (partner?.id) {
            if (!overMap[sp.id].partnerBidrag[partner.id]) {
              overMap[sp.id].partnerBidrag[partner.id] = { navn: partner.navn ?? 'Ukjent', bidragSum: 0, kamper: 0 };
            }
            overMap[sp.id].partnerBidrag[partner.id].bidragSum += (faktisk - forventet);
            overMap[sp.id].partnerBidrag[partner.id].kamper++;
          }
        });
      };

      registrer(lag1, faktiskA, forventetA);
      registrer(lag2, faktiskB, forventetB);
    }

    // ── 1. FORMSPILLEREN — høyest snitt overperformance ──
    // Kun spillere med minst SESONG_MIN_KAMPER kamper
    const kandidaterForm = Object.entries(overMap)
      .filter(([, v]) => v.kamper >= SESONG_MIN_KAMPER)
      .map(([id, v]) => ({
        id,
        navn:          v.navn,
        kamper:        v.kamper,
        overperf:      v.bidragSum / v.kamper,  // snitt per kamp
        overperfPst:   Math.round((v.bidragSum / v.kamper) * 100),
      }))
      .sort((a, b) => b.overperf - a.overperf);

    // ── 2. BESTE PARTNER — høyest snitt overperformance
    //    på tvers av alle partnere (vektet etter antall kamper)
    const kandidaterPartner = Object.entries(overMap)
      .filter(([, v]) => v.kamper >= SESONG_MIN_KAMPER)
      .map(([id, v]) => {
        // Snitt overperformance over alle partnere med minst 2 kamper
        const partnere = Object.values(v.partnerBidrag).filter(p => p.kamper >= 2);
        if (partnere.length === 0) return null;

        // Vektet snitt: partnere med mange kamper teller mer
        const totalKamper  = partnere.reduce((s, p) => s + p.kamper, 0);
        const vektetBidrag = partnere.reduce((s, p) => s + p.bidragSum, 0);
        const snittOverperf = vektetBidrag / totalKamper;

        return {
          id,
          navn:          v.navn,
          kamper:        v.kamper,
          antallPartnere: partnere.length,
          overperf:      snittOverperf,
          overperfPst:   Math.round(snittOverperf * 100),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.overperf - a.overperf);

    // ── Vis resultater ────────────────────────────────────
    if (sesongLaster) sesongLaster.style.display = 'none';

    const ingenData = '<div style="padding:10px 0;font-size:15px;color:var(--muted2)">Ikke nok kampdata ennå (min. ' + SESONG_MIN_KAMPER + ' kamper per spiller)</div>';

    // Formspilleren
    const formEl = document.getElementById('sesong-formspiller');
    if (formEl) {
      if (kandidaterForm.length === 0) {
        formEl.innerHTML = ingenData;
      } else {
        formEl.innerHTML = kandidaterForm.slice(0, 3).map((s, i) => {
          const ini    = s.navn.split(' ').map(w => w[0] ?? '').join('').slice(0,2).toUpperCase() || '?';
          const farge  = s.overperfPst >= 0 ? 'var(--green2)' : 'var(--red2)';
          const tegn   = s.overperfPst >= 0 ? '+' : '';
          const kronet = i === 0;
          return `<div class="lb-rad" onclick="apneGlobalProfil('${s.id}')" style="cursor:pointer;${kronet ? 'background:rgba(234,179,8,0.04)' : ''}">
            <div class="lb-plass${kronet ? ' topp3' : ''}" style="font-size:${kronet ? '24' : '18'}px">${kronet ? '🔥' : i + 1}</div>
            <div class="lb-avatar" style="${kronet ? 'background:var(--yellow);color:#000' : ''}">${ini}</div>
            <div style="flex:1">
              <div style="font-size:${kronet ? '17' : '16'}px;font-weight:${kronet ? '600' : '400'}">${escHtml(s.navn)}</div>
              <div style="font-size:13px;color:var(--muted2);margin-top:2px">${s.kamper} kamper</div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:700;color:${farge}">${tegn}${s.overperfPst}%</div>
              <div style="font-size:12px;color:var(--muted2)">over forventet</div>
            </div>
          </div>`;
        }).join('');
      }
    }

    // Beste partner
    const partnerEl = document.getElementById('sesong-beste-partner');
    if (partnerEl) {
      if (kandidaterPartner.length === 0) {
        partnerEl.innerHTML = ingenData;
      } else {
        partnerEl.innerHTML = kandidaterPartner.slice(0, 3).map((s, i) => {
          const ini    = s.navn.split(' ').map(w => w[0] ?? '').join('').slice(0,2).toUpperCase() || '?';
          const farge  = s.overperfPst >= 0 ? 'var(--green2)' : 'var(--red2)';
          const tegn   = s.overperfPst >= 0 ? '+' : '';
          const kronet = i === 0;
          return `<div class="lb-rad" onclick="apneGlobalProfil('${s.id}')" style="cursor:pointer;${kronet ? 'background:rgba(59,130,246,0.05)' : ''}">
            <div class="lb-plass${kronet ? ' topp3' : ''}" style="font-size:${kronet ? '24' : '18'}px">${kronet ? '🤝' : i + 1}</div>
            <div class="lb-avatar" style="${kronet ? 'background:var(--accent2);color:#fff' : ''}">${ini}</div>
            <div style="flex:1">
              <div style="font-size:${kronet ? '17' : '16'}px;font-weight:${kronet ? '600' : '400'}">${escHtml(s.navn)}</div>
              <div style="font-size:13px;color:var(--muted2);margin-top:2px">${s.antallPartnere} partner${s.antallPartnere === 1 ? '' : 'e'} • ${s.kamper} kamper</div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:700;color:${farge}">${tegn}${s.overperfPst}%</div>
              <div style="font-size:12px;color:var(--muted2)">snitt løft</div>
            </div>
          </div>`;
        }).join('');
      }
    }

    if (sesongBoks) {
      sesongBoks.style.display = 'block';
      _sesongCache = { html: sesongBoks.innerHTML, hentetMs: Date.now() };
    }

  } catch (e) {
    console.warn('[Sesongkåring]', e?.message ?? e);
    if (sesongLaster) sesongLaster.style.display = 'none';
  }
}

// ════════════════════════════════════════════════════════
// SAMMENLIGN SPILLERE
// ════════════════════════════════════════════════════════

function nullstillSammenligning() {
  const s1 = document.getElementById('sammenlign-s1')?.value;
  const s2 = document.getElementById('sammenlign-s2')?.value;
  const knapp = document.getElementById('sammenlign-knapp');
  const res   = document.getElementById('sammenlign-resultat');
  if (knapp) knapp.disabled = !(s1 && s2 && s1 !== s2);
  if (res)   { res.style.display = 'none'; res.innerHTML = ''; }
}
window.nullstillSammenligning = nullstillSammenligning;

async function kjorSammenligning() {
  if (!db) return;
  const s1Id = document.getElementById('sammenlign-s1')?.value;
  const s2Id = document.getElementById('sammenlign-s2')?.value;
  if (!s1Id || !s2Id || s1Id === s2Id) return;

  const s1Navn = document.getElementById('sammenlign-s1').selectedOptions[0]?.text.split(' (')[0] ?? 'Spiller 1';
  const s2Navn = document.getElementById('sammenlign-s2').selectedOptions[0]?.text.split(' (')[0] ?? 'Spiller 2';

  const laster  = document.getElementById('sammenlign-laster');
  const resultat = document.getElementById('sammenlign-resultat');
  if (laster)   laster.style.display   = 'flex';
  if (resultat) resultat.style.display = 'none';

  try {
    // Hent alle kamper der s1 deltok (4 spørringer — én per lagfelt)
    const [a1, a2, a3, a4] = await Promise.all([
      getDocs(query(collection(db, SAM.KAMPER), where('lag1_s1', '==', s1Id), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag1_s2', '==', s1Id), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag2_s1', '==', s1Id), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag2_s2', '==', s1Id), where('ferdig', '==', true))),
    ]);

    // Slå sammen og dedupliser
    const sett = new Map();
    for (const snap of [a1, a2, a3, a4]) {
      snap.docs.forEach(d => sett.set(d.id, { id: d.id, ...d.data() }));
    }
    const alleKamperS1 = [...sett.values()];

    // Finn kamper der BEGGE spillerne deltok
    const fellesKamper = alleKamperS1.filter(k => {
      const ids = [k.lag1_s1, k.lag1_s2, k.lag2_s1, k.lag2_s2];
      return ids.includes(s2Id);
    });

    // ── Individuelle nøkkeltall fra beregnKampStatistikk ──
    const stat1 = beregnKampStatistikk(s1Id, alleKamperS1);

    // Hent alle kamper for s2 også
    const [b1, b2, b3, b4] = await Promise.all([
      getDocs(query(collection(db, SAM.KAMPER), where('lag1_s1', '==', s2Id), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag1_s2', '==', s2Id), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag2_s1', '==', s2Id), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag2_s2', '==', s2Id), where('ferdig', '==', true))),
    ]);
    const sett2 = new Map();
    for (const snap of [b1, b2, b3, b4]) {
      snap.docs.forEach(d => sett2.set(d.id, { id: d.id, ...d.data() }));
    }
    const alleKamperS2 = [...sett2.values()];
    const stat2 = beregnKampStatistikk(s2Id, alleKamperS2);

    // ── Analyser felles kamper ────────────────────────────
    let sammenLag = 0, sammenSeire = 0;
    let motHverandre = 0, s1VantMot = 0;

    for (const k of fellesKamper) {
      const s1PaaLag1 = k.lag1_s1 === s1Id || k.lag1_s2 === s1Id;
      const s2PaaLag1 = k.lag1_s1 === s2Id || k.lag1_s2 === s2Id;

      if (s1PaaLag1 === s2PaaLag1) {
        // Samme lag
        sammenLag++;
        const vant = s1PaaLag1 ? k.lag1Poeng > k.lag2Poeng : k.lag2Poeng > k.lag1Poeng;
        if (vant) sammenSeire++;
      } else {
        // Mot hverandre
        motHverandre++;
        const s1Vant = s1PaaLag1 ? k.lag1Poeng > k.lag2Poeng : k.lag2Poeng > k.lag1Poeng;
        if (s1Vant) s1VantMot++;
      }
    }

    // ── Bygg resultat-HTML ────────────────────────────────
    if (laster) laster.style.display = 'none';

    const ini1 = s1Navn.split(' ').map(w => w[0] ?? '').join('').slice(0,2).toUpperCase() || '?';
    const ini2 = s2Navn.split(' ').map(w => w[0] ?? '').join('').slice(0,2).toUpperCase() || '?';

    const wrFarge = (wr) => wr === null ? 'var(--muted2)' : wr >= 60 ? 'var(--green2)' : wr >= 40 ? 'var(--yellow)' : 'var(--red2)';
    const wrTekst = (wr) => wr === null ? '—' : wr + '%';

    // Sammenligningstabellen
    const rader = [
      { lbl: 'Winrate',      v1: wrTekst(stat1.winRate),  v2: wrTekst(stat2.winRate),  farge1: wrFarge(stat1.winRate),  farge2: wrFarge(stat2.winRate) },
      { lbl: 'Snittpoeng',   v1: stat1.avgPoints ?? '—',  v2: stat2.avgPoints ?? '—',  farge1: 'var(--white)',          farge2: 'var(--white)' },
      { lbl: 'Totalt kamper',v1: stat1.totalKamper,        v2: stat2.totalKamper,        farge1: 'var(--white)',          farge2: 'var(--white)' },
    ];

    let html = `
      <!-- Spillerhoder -->
      <div style="display:flex;align-items:center;gap:8px;padding:14px 16px 10px;border-bottom:1px solid var(--border)">
        <div style="flex:1;display:flex;align-items:center;gap:8px">
          <div class="lb-avatar" style="background:var(--accent)">${ini1}</div>
          <div style="font-size:16px;font-weight:600">${escHtml(s1Navn)}</div>
        </div>
        <div style="font-family:'Bebas Neue',cursive;font-size:18px;color:var(--muted)">VS</div>
        <div style="flex:1;display:flex;align-items:center;justify-content:flex-end;gap:8px">
          <div style="font-size:16px;font-weight:600;text-align:right">${escHtml(s2Navn)}</div>
          <div class="lb-avatar" style="background:var(--orange)">${ini2}</div>
        </div>
      </div>

      <!-- Nøkkeltall -->
      <div style="padding:0 16px">
        ${rader.map(r => `
          <div style="display:flex;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
            <div style="flex:1;font-family:'DM Mono',monospace;font-size:17px;font-weight:600;color:${r.farge1}">${r.v1}</div>
            <div style="font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--muted2);text-align:center;flex:0 0 90px">${r.lbl}</div>
            <div style="flex:1;font-family:'DM Mono',monospace;font-size:17px;font-weight:600;color:${r.farge2};text-align:right">${r.v2}</div>
          </div>`).join('')}
      </div>`;

    // Direkte oppgjør
    if (fellesKamper.length === 0) {
      html += `<div style="padding:14px 16px;text-align:center;font-size:15px;color:var(--muted2)">
        Ingen felles kamper registrert ennå.
      </div>`;
    } else {
      html += `<div style="padding:12px 16px 4px">
        <div style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--accent2);font-weight:600;margin-bottom:10px">Direkte oppgjør</div>`;

      if (motHverandre > 0) {
        const s2VantMot = motHverandre - s1VantMot;
        const vinnerId  = s1VantMot > s2VantMot ? s1Navn : s2VantMot > s1VantMot ? s2Navn : null;
        const fargeS1   = s1VantMot > s2VantMot ? 'var(--green2)' : s1VantMot < s2VantMot ? 'var(--red2)' : 'var(--muted2)';
        const fargeS2   = s2VantMot > s1VantMot ? 'var(--green2)' : s2VantMot < s1VantMot ? 'var(--red2)' : 'var(--muted2)';
        html += `
          <div style="display:flex;align-items:center;background:#060e1c;border-radius:12px;padding:12px 14px;margin-bottom:8px">
            <div style="flex:1;font-family:'Bebas Neue',cursive;font-size:32px;color:${fargeS1}">${s1VantMot}</div>
            <div style="font-size:13px;text-align:center;color:var(--muted2);flex:0 0 80px">${motHverandre} kamper<br>mot hverandre</div>
            <div style="flex:1;font-family:'Bebas Neue',cursive;font-size:32px;color:${fargeS2};text-align:right">${s2VantMot}</div>
          </div>
          ${vinnerId ? `<div style="text-align:center;font-size:14px;color:var(--muted2);margin-bottom:8px">🏆 ${escHtml(vinnerId)} leder det direkte oppgjøret</div>` : '<div style="text-align:center;font-size:14px;color:var(--muted2);margin-bottom:8px">Likt i det direkte oppgjøret</div>'}`;
      }

      if (sammenLag > 0) {
        const sammenWR  = Math.round((sammenSeire / sammenLag) * 100);
        const wrF = sammenWR >= 60 ? 'var(--green2)' : sammenWR >= 40 ? 'var(--yellow)' : 'var(--red2)';
        html += `
          <div style="display:flex;align-items:center;gap:12px;background:#060e1c;border-radius:12px;padding:12px 14px;margin-bottom:8px">
            <div style="font-size:22px">🤝</div>
            <div style="flex:1">
              <div style="font-size:15px;font-weight:600">Sammen som lag</div>
              <div style="font-size:13px;color:var(--muted2);margin-top:2px">${sammenLag} kamper — ${sammenSeire} seire</div>
            </div>
            <div style="font-family:'DM Mono',monospace;font-size:22px;font-weight:700;color:${wrF}">${sammenWR}%</div>
          </div>`;
      }

      html += '</div>';
    }

    if (resultat) {
      resultat.innerHTML = html;
      resultat.style.display = 'block';
    }

  } catch (e) {
    console.error('[sammenlign]', e);
    if (laster) laster.style.display = 'none';
    visFBFeil('Feil ved sammenligning: ' + (e?.message ?? e));
  }
}
window.kjorSammenligning = kjorSammenligning;

let globalDiagram = null;
async function apneGlobalProfil(spillerId) {
  if (!db || !spillerId) return;

  // Hent spillerdata
  let spiller;
  try {
    const snap = await getDoc(doc(db, SAM.SPILLERE, spillerId));
    if (!snap.exists()) { visMelding('Spiller ikke funnet.', 'feil'); return; }
    spiller = { id: snap.id, ...snap.data() };
  } catch (e) {
    visFBFeil('Kunne ikke hente spiller: ' + (e?.message ?? e));
    return;
  }

  document.getElementById('global-profil-navn').textContent = spiller.navn ?? 'Ukjent';
  // Vis rating med nivå-label under rating-hero
  const ratingEl = document.getElementById('global-profil-rating');
  if (ratingEl) ratingEl.textContent = spiller.rating ?? STARTRATING;
  // Vis nivå-label under rating-tallet
  const nLabel = getNivaaLabel(spiller.rating ?? STARTRATING);
  const nLabelEl = document.getElementById('global-profil-nivaa-label');
  if (nLabelEl) {
    nLabelEl.className = `nivaa-label ${nLabel.kl}`;
    nLabelEl.textContent = `${nLabel.ikon} ${nLabel.tekst}`;
    nLabelEl.style.display = 'inline-flex';
  }

  // Hent historikk
  let historikk = [];
  try {
    const snap = await getDocs(
      query(collection(db, SAM.HISTORIKK), where('spillerId', '==', spillerId))
    );
    historikk = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.dato?.toMillis?.() ?? 0) - (b.dato?.toMillis?.() ?? 0));
  } catch (e) {
    console.warn('Historikk ikke tilgjengelig:', e?.message ?? e);
  }

  // Statistikk-boks
  const antallTreninger = historikk.length;
  const bestePlass = historikk.length
    ? Math.min(...historikk.map(h => h.plassering ?? 999))
    : '—';
  const totalEndring = historikk.reduce((sum, h) => sum + (h.endring ?? 0), 0);

  document.getElementById('global-profil-statistikk').innerHTML = [
    { val: antallTreninger, lbl: 'Økter',     farge: 'var(--white)' },
    { val: bestePlass === 999 ? '—' : '#' + bestePlass, lbl: 'Beste plass', farge: 'var(--yellow)' },
    { val: (totalEndring >= 0 ? '+' : '') + totalEndring, lbl: 'Total Δ rating', farge: totalEndring >= 0 ? 'var(--green2)' : 'var(--red2)' },
  ].map(b => `<div class="stat-boks">
    <div class="stat-verdi" style="color:${b.farge}">${b.val}</div>
    <div class="stat-etikett">${b.lbl}</div>
  </div>`).join('');

  // Diagram
  const ratingData = historikk.length
    ? [STARTRATING, ...historikk.map(h => h.ratingEtter ?? STARTRATING)]
    : [spiller.rating ?? STARTRATING];
  const etiketter = historikk.length
    ? ['Start', ...historikk.map((_, i) => 'T' + (i+1))]
    : ['Nå'];

  if (globalDiagram) { try { globalDiagram.destroy(); } catch (_) {} globalDiagram = null; }
  const canvas = document.getElementById('global-rating-diagram');
  if (canvas) {
    globalDiagram = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: etiketter,
        datasets: [{
          data: ratingData, borderColor: '#eab308',
          backgroundColor: 'rgba(234,179,8,0.08)', borderWidth: 2.5,
          pointRadius: 5, pointBackgroundColor: '#eab308',
          pointBorderColor: '#050f1f', pointBorderWidth: 2,
          tension: 0.35, fill: true,
        }],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 11 } } },
          y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 11 } } },
        },
      },
    });
  }

  // Øktsoversikt
  document.getElementById('global-trening-historikk').innerHTML = historikk.length
    ? [...historikk].reverse().map((h, i) => `
        <div class="historikk-rad">
          <div style="flex:1">Økt ${historikk.length - i}</div>
          <div style="font-family:'DM Mono',monospace;font-size:14px;color:var(--muted2);margin-right:8px">Plass #${h.plassering ?? '—'}</div>
          <div style="font-family:'DM Mono',monospace;font-size:16px;font-weight:600;color:${(h.endring ?? 0) >= 0 ? 'var(--green2)' : 'var(--red2)'}">
            ${(h.endring ?? 0) >= 0 ? '+' : ''}${h.endring ?? 0}
          </div>
        </div>`).join('')
    : '<div style="padding:16px;text-align:center;font-size:16px;color:var(--muted2)">Ingen historikk ennå</div>';

  aktivSlettSpillerId = spillerId;  // lagres for slett-modal

  // Nullstill kampstat-seksjonen og start lasting
  const kampStatEl = document.getElementById('global-kampstat-innhold');
  if (kampStatEl) kampStatEl.innerHTML = '<div class="kampstat-laster">Beregner statistikk…</div>';

  naviger('global-profil');

  // Hent og vis kampstatistikk + trend asynkront — blokkerer ikke navigeringen
  hentKampStatistikk(spillerId).then(stat => {
    // historikk er allerede hentet ovenfor i samme scope — beregn trend her
    const trendData = beregnTrend(historikk);
    visKampStatistikk(stat, trendData);
  });
}
window.apneGlobalProfil = apneGlobalProfil;


// ════════════════════════════════════════════════════════
// KAMPSTATISTIKK — winrate, snittpoeng, beste partner
// ════════════════════════════════════════════════════════

// Cache: spillerId → { stat, hentetMs }
const kampStatCache = new Map();
const KAMPSTAT_TTL_MS = 5 * 60 * 1000; // 5 min TTL — ungår unødvendige Firestore-kall

/**
 * Beregner kampstatistikk for én spiller ut fra et sett med kamper.
 *
 * Kampstruktur (fra Firestore):
 *   lag1_s1, lag1_s2  — IDs på lag 1
 *   lag2_s1, lag2_s2  — IDs på lag 2
 *   lag1Poeng, lag2Poeng — poeng (null hvis ikke ferdig)
 *   ferdig: boolean
 *
 * @param {string} spillerId
 * @param {Array}  kamper   — alle ferdigspilte kamper for spilleren
 * @returns {{ winRate, avgPoints, bestPartner }}
 */
function beregnKampStatistikk(spillerId, kamper) {
  // Edge case: ingen kamper
  if (!kamper?.length) {
    return { winRate: null, avgPoints: null, bestPartner: null, form: [], totalKamper: 0 };
  }

  let seire = 0, totaltPoeng = 0, antallKamper = 0;
  const partnerMap = {};
  // Samle alle resultater kronologisk for form-beregning
  const alleResultater = [];

  for (const k of kamper) {
    if (!k.ferdig || k.lag1Poeng == null || k.lag2Poeng == null) continue;

    const erLag1 = k.lag1_s1 === spillerId || k.lag1_s2 === spillerId;
    const erLag2 = k.lag2_s1 === spillerId || k.lag2_s2 === spillerId;
    if (!erLag1 && !erLag2) continue;

    const egnePoeng       = erLag1 ? k.lag1Poeng : k.lag2Poeng;
    const motstanderPoeng = erLag1 ? k.lag2Poeng : k.lag1Poeng;
    const vant            = egnePoeng > motstanderPoeng;

    totaltPoeng += egnePoeng;
    antallKamper++;
    if (vant) seire++;

    // Lagre for form — behold tidsstempel om tilgjengelig
    alleResultater.push({ vant, dato: k.dato ?? null });

    // Partner-akkumulering
    const partnerId = erLag1
      ? (k.lag1_s1 === spillerId ? k.lag1_s2 : k.lag1_s1)
      : (k.lag2_s1 === spillerId ? k.lag2_s2 : k.lag2_s1);
    const partnerNavn = erLag1
      ? (k.lag1_s1 === spillerId ? k.lag1_s2_navn : k.lag1_s1_navn)
      : (k.lag2_s1 === spillerId ? k.lag2_s2_navn : k.lag2_s1_navn);

    if (partnerId) {
      if (!partnerMap[partnerId]) {
        partnerMap[partnerId] = { navn: partnerNavn ?? 'Ukjent', seire: 0, kamper: 0 };
      }
      partnerMap[partnerId].kamper++;
      if (vant) partnerMap[partnerId].seire++;
    }
  }

  if (antallKamper === 0) {
    return { winRate: null, avgPoints: null, bestPartner: null, form: [], totalKamper: 0 };
  }

  const winRate   = Math.round((seire / antallKamper) * 100);
  const avgPoints = Math.round((totaltPoeng / antallKamper) * 10) / 10;

  // Form: siste 5 kamper som ['W','L',...] — nyeste til venstre
  const form = alleResultater
    .slice(-5)
    .reverse()
    .map(r => r.vant ? 'W' : 'L');

  // Beste partner — høyest winrate blant partnere med minst 2 kamper
  let bestPartner = null;
  let bestWR = -1;
  for (const [id, p] of Object.entries(partnerMap)) {
    if (p.kamper < 2) continue;
    const wr = p.seire / p.kamper;
    if (wr > bestWR) {
      bestWR      = wr;
      bestPartner = { id, navn: p.navn, winRate: Math.round(wr * 100), kamper: p.kamper };
    }
  }
  // Fallback: flest kamper
  if (!bestPartner && Object.keys(partnerMap).length > 0) {
    const [id, p] = Object.entries(partnerMap).sort((a, b) => b[1].kamper - a[1].kamper)[0];
    bestPartner = { id, navn: p.navn, winRate: Math.round((p.seire / p.kamper) * 100), kamper: p.kamper };
  }

  return { winRate, avgPoints, bestPartner, form, totalKamper: antallKamper };
}

// ────────────────────────────────────────────────────────
// TREND — rating-utvikling siste 5 økter
// Leser fra historikk-arrayet (allerede hentet i apneGlobalProfil)
// ────────────────────────────────────────────────────────

/**
 * Henter kampstatistikk for en spiller — med cache.
 * Unngår Firestore-kall hvis dataene er < 5 min gamle.
 *
 * @param {string} spillerId
 * @returns {Promise<{ winRate, avgPoints, bestPartner }>}
 */
async function hentKampStatistikk(spillerId) {
  // Sjekk cache
  const cached = kampStatCache.get(spillerId);
  if (cached && (Date.now() - cached.hentetMs) < KAMPSTAT_TTL_MS) {
    return cached.stat;
  }

  // Hent fra Firestore — kun ferdigspilte kamper for denne spilleren
  // Firestore støtter ikke array-contains på flere felt, så vi søker
  // på lag1_s1 og lag2_s1 og slår sammen — henter begge halvparter.
  // Dette er to enkle where-queries uten sammensatt indeks.
  let kamper = [];
  try {
    const [s1, s2, s3, s4] = await Promise.all([
      getDocs(query(collection(db, SAM.KAMPER), where('lag1_s1', '==', spillerId), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag1_s2', '==', spillerId), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag2_s1', '==', spillerId), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag2_s2', '==', spillerId), where('ferdig', '==', true))),
    ]);

    // Deduplisering med Set på dokument-ID
    const sett = new Map();
    for (const snap of [s1, s2, s3, s4]) {
      snap.docs.forEach(d => sett.set(d.id, { id: d.id, ...d.data() }));
    }
    kamper = [...sett.values()];
  } catch (e) {
    console.warn('[KampStat] Henting feilet:', e?.message ?? e);
    return { winRate: null, avgPoints: null, bestPartner: null };
  }

  const stat = beregnKampStatistikk(spillerId, kamper);

  // Lagre i cache
  kampStatCache.set(spillerId, { stat, hentetMs: Date.now() });

  return stat;
}

/**
 * Renderer kampstatistikk inn i global-profil-skjermen.
 * @param {{ winRate, avgPoints, bestPartner, form, totalKamper }} stat
 * @param {{ trend, change }}                                      trendData
 */
function visKampStatistikk(stat, trendData = null) {
  const el = document.getElementById('global-kampstat-innhold');
  if (!el) return;

  if (stat.winRate === null) {
    el.innerHTML = `<div class="kampstat-laster">Ingen kampdata tilgjengelig ennå</div>`;
    return;
  }

  const wrFarge = stat.winRate >= 60 ? 'var(--green2)' : stat.winRate >= 40 ? 'var(--yellow)' : 'var(--red2)';

  // ── Trend-boks ─────────────────────────────────────────
  let trendHTML = '';
  if (trendData) {
    const { trend, change } = trendData;
    const pil    = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→';
    const farge  = trend === 'up' ? 'var(--green2)' : trend === 'down' ? 'var(--red2)' : 'var(--muted2)';
    const tekst  = trend === 'up' ? 'Stigende form' : trend === 'down' ? 'Fallende form' : 'Stabil form';
    const antall = Math.min(5, /* historikklengde sendes ikke hit — bruk change */ 5);
    trendHTML = `
      <div class="seksjon-etikett">Trend (siste 5 økter)</div>
      <div class="trend-boks">
        <div class="trend-pil" style="color:${farge}">${pil}</div>
        <div class="trend-info">
          <div class="trend-tittel" style="color:${farge}">${tekst}</div>
          <div class="trend-sub">Basert på siste 5 økt-resultater</div>
        </div>
        <div class="trend-endring" style="color:${farge}">${change > 0 ? '+' : ''}${change}</div>
      </div>`;
  }

  // ── Form-badges ────────────────────────────────────────
  let formHTML = '';
  if (stat.form?.length) {
    // Fyll opp til 5 med tomme plasser om færre kamper
    const badges = [...stat.form];
    while (badges.length < 5) badges.push(null);
    formHTML = `
      <div class="seksjon-etikett">Form (siste kamper)</div>
      <div class="form-rekke">
        ${badges.map(r => r === null
          ? `<div class="form-badge form-badge-tom">·</div>`
          : `<div class="form-badge form-badge-${r}">${r}</div>`
        ).join('')}
        <div style="flex:1;display:flex;align-items:center;padding-left:8px;font-size:14px;color:var(--muted2)">
          ${stat.totalKamper} kamp${stat.totalKamper === 1 ? '' : 'er'} totalt
        </div>
      </div>`;
  }

  // ── Beste partner / kjemi ─────────────────────────────
  let partnerHTML = '';
  if (stat.bestPartner) {
    const ini = (stat.bestPartner.navn ?? '?').split(' ').map(w => w[0] ?? '').join('').slice(0,2).toUpperCase() || '?';
    const wrF = stat.bestPartner.winRate >= 60 ? 'var(--green2)' : stat.bestPartner.winRate >= 40 ? 'var(--yellow)' : 'var(--red2)';
    // Kjemi-stolpe: visuell winrate-bar
    const barBredd = Math.round(stat.bestPartner.winRate);
    partnerHTML = `
      <div class="seksjon-etikett">Beste kjemi</div>
      <div class="beste-partner-boks" style="flex-direction:column;align-items:stretch;gap:10px">
        <div style="display:flex;align-items:center;gap:12px">
          <div class="beste-partner-avatar">${ini}</div>
          <div class="beste-partner-info">
            <div class="beste-partner-navn">${stat.bestPartner.navn}</div>
            <div class="beste-partner-stat">${stat.bestPartner.kamper} kamper sammen</div>
          </div>
          <div style="text-align:right">
            <div style="font-family:'DM Mono',monospace;font-size:22px;font-weight:700;color:${wrF}">${stat.bestPartner.winRate}%</div>
            <div style="font-size:14px;color:var(--muted2)">winrate</div>
          </div>
        </div>
        <div style="background:var(--border);border-radius:4px;height:6px;overflow:hidden">
          <div style="width:${barBredd}%;height:100%;background:${wrF};border-radius:4px;transition:width .5s"></div>
        </div>
      </div>`;
  }

  // ── Hoved-statistikk-grid ─────────────────────────────
  el.innerHTML = `
    <div class="kampstat-rutenett">
      <div class="kampstat-boks">
        <div class="kampstat-verdi" style="color:${wrFarge}">${stat.winRate}%</div>
        <div class="kampstat-etikett">Winrate</div>
      </div>
      <div class="kampstat-boks">
        <div class="kampstat-verdi" style="color:var(--white)">${stat.avgPoints}</div>
        <div class="kampstat-etikett">Snitt poeng</div>
      </div>
      <div class="kampstat-boks">
        <div class="kampstat-verdi" style="font-size:22px;color:var(--accent2)">${stat.totalKamper}</div>
        <div class="kampstat-etikett">Kamper</div>
      </div>
    </div>
    ${trendHTML}
    ${formHTML}
    ${partnerHTML}`;
}

// ════════════════════════════════════════════════════════
// NULLSTILL RATING OG HISTORIKK (admin)
// ════════════════════════════════════════════════════════
function visNullstillModal() {
  krevAdminMedDemo(
    'Nullstill rating',
    'Kun administrator kan nullstille all rating og historikk.',
    () => {
      document.getElementById('modal-nullstill').style.display = 'flex';
    }
  );
}
window.visNullstillModal = visNullstillModal;

async function utforNullstill() {
  if (!db) { visMelding('Firebase ikke tilkoblet.', 'feil'); return; }
  document.getElementById('modal-nullstill').style.display = 'none';

  visMelding('Nullstiller… vennligst vent.', 'advarsel');

  try {
    // 1. Hent alle spillere og sett rating = 1000
    const spillerSnap = await getDocs(collection(db, SAM.SPILLERE));
    const BATCH_MAKS = 400; // Firestore batch-grense er 500 — bruker 400 for sikkerhet
    let batch = writeBatch(db);
    let teller = 0;

    for (const d of spillerSnap.docs) {
      batch.update(d.ref, { rating: STARTRATING });
      teller++;
      if (teller >= BATCH_MAKS) {
        await batch.commit();
        batch = writeBatch(db);
        teller = 0;
      }
    }
    if (teller > 0) await batch.commit();

    // 2. Slett all ratinghistorikk
    const histSnap = await getDocs(collection(db, SAM.HISTORIKK));
    batch = writeBatch(db);
    teller = 0;
    for (const d of histSnap.docs) {
      batch.delete(d.ref);
      teller++;
      if (teller >= BATCH_MAKS) {
        await batch.commit();
        batch = writeBatch(db);
        teller = 0;
      }
    }
    if (teller > 0) await batch.commit();

    // 3. Slett alle resultater
    const resSnap = await getDocs(collection(db, SAM.RESULTATER));
    batch = writeBatch(db);
    teller = 0;
    for (const d of resSnap.docs) {
      batch.delete(d.ref);
      teller++;
      if (teller >= BATCH_MAKS) {
        await batch.commit();
        batch = writeBatch(db);
        teller = 0;
      }
    }
    if (teller > 0) await batch.commit();

    // 4. Oppdater lokal spillerliste
    app.spillere = app.spillere.map(s => ({ ...s, rating: STARTRATING }));

    _sesongCache = null;
    visMelding('Rating og historikk nullstilt!');
    oppdaterGlobalLedertavle();
  } catch (e) {
    visFBFeil('Feil ved nullstilling: ' + (e?.message ?? e));
  }
}
window.utforNullstill = utforNullstill;

// ════════════════════════════════════════════════════════
// SLETT ALLE SPILLERE (admin)
// ════════════════════════════════════════════════════════
async function visSlettAlleSpillereModal() {
  if (!db) { visMelding('Firebase ikke tilkoblet.', 'feil'); return; }
  krevAdminMedDemo(
    'Slett alle spillere',
    'Kun administrator kan slette alle spillere.',
    async () => {
      try {
        const snap   = await getDocs(collection(db, SAM.SPILLERE));
        const antall = snap.size;
        document.getElementById('slett-alle-spillere-teller').textContent =
          antall === 0
            ? 'Ingen spillere funnet.'
            : `${antall} spiller${antall === 1 ? '' : 'e'} vil bli slettet.`;
        document.getElementById('modal-slett-alle-spillere').style.display = 'flex';
      } catch (e) {
        visFBFeil('Kunne ikke telle spillere: ' + (e?.message ?? e));
      }
    }
  );
}
window.visSlettAlleSpillereModal = visSlettAlleSpillereModal;

async function utforSlettAlleSpillere() {
  if (!db) { visMelding('Firebase ikke tilkoblet.', 'feil'); return; }
  document.getElementById('modal-slett-alle-spillere').style.display = 'none';
  visMelding('Sletter alle spillere… vennligst vent.', 'advarsel');

  try {
    const BATCH_MAKS = 400;
    let batch  = writeBatch(db);
    let teller = 0;

    const kommit = async () => {
      if (teller > 0) { await batch.commit(); batch = writeBatch(db); teller = 0; }
    };
    const slettDoc = async (ref) => {
      batch.delete(ref);
      teller++;
      if (teller >= BATCH_MAKS) await kommit();
    };

    // Hent alle spiller-IDer
    const spillerSnap = await getDocs(collection(db, SAM.SPILLERE));
    const spillerIds  = spillerSnap.docs.map(d => d.id);

    if (spillerIds.length === 0) {
      visMelding('Ingen spillere å slette.', 'advarsel');
      return;
    }

    // Slett alle spillerdokumenter
    for (const d of spillerSnap.docs) await slettDoc(d.ref);

    // Slett tilknyttet data i grupper på 10 (Firestore where-in grense)
    const samlingerMedSpillerId = [SAM.HISTORIKK, SAM.RESULTATER, SAM.TS];
    for (const sam of samlingerMedSpillerId) {
      for (let i = 0; i < spillerIds.length; i += 10) {
        const gruppe = spillerIds.slice(i, i + 10);
        const snap = await getDocs(
          query(collection(db, sam), where('spillerId', 'in', gruppe))
        );
        for (const d of snap.docs) await slettDoc(d.ref);
      }
    }

    await kommit();

    // Nullstill lokal tilstand
    app.spillere = [];
    app.valgtIds.clear();

    _sesongCache = null;
    visMelding(`${spillerIds.length} spiller${spillerIds.length === 1 ? '' : 'e'} slettet.`);
    oppdaterGlobalLedertavle();
  } catch (e) {
    console.error('[slettAlleSpillere]', e);
    visFBFeil('Feil ved sletting av spillere: ' + (e?.message ?? e));
  }
}
window.utforSlettAlleSpillere = utforSlettAlleSpillere;


// ════════════════════════════════════════════════════════
// SLETT SPILLER (admin)
// ════════════════════════════════════════════════════════
let aktivSlettSpillerId = null;

function visSlettSpillerModal() {
  const navn = document.getElementById('global-profil-navn').textContent;
  const id   = aktivSlettSpillerId;
  if (!id) return;
  krevAdminMedDemo(
    'Slett spiller',
    `Bekreft at du vil slette ${navn} permanent.`,
    () => {
      document.getElementById('slett-spiller-navn').textContent = navn;
      document.getElementById('modal-slett-spiller').style.display = 'flex';
    }
  );
}
window.visSlettSpillerModal = visSlettSpillerModal;

async function utforSlettSpiller() {
  if (!db || !aktivSlettSpillerId) return;
  document.getElementById('modal-slett-spiller').style.display = 'none';
  const spillerId = aktivSlettSpillerId;
  visMelding('Sletter spiller…', 'advarsel');

  try {
    const BATCH_MAKS = 400;
    let batch  = writeBatch(db);
    let teller = 0;

    const kommit = async () => {
      if (teller > 0) { await batch.commit(); batch = writeBatch(db); teller = 0; }
    };
    const leggTil = (op, ref, data) => {
      if (op === 'delete') batch.delete(ref); else batch.update(ref, data);
      teller++;
      if (teller >= BATCH_MAKS) return kommit();
      return Promise.resolve();
    };

    // Slett spillerdokument
    await leggTil('delete', doc(db, SAM.SPILLERE, spillerId));

    // Slett ratinghistorikk
    const histSnap = await getDocs(
      query(collection(db, SAM.HISTORIKK), where('spillerId', '==', spillerId))
    );
    for (const d of histSnap.docs) await leggTil('delete', d.ref);

    // Slett resultater
    const resSnap = await getDocs(
      query(collection(db, SAM.RESULTATER), where('spillerId', '==', spillerId))
    );
    for (const d of resSnap.docs) await leggTil('delete', d.ref);

    // Slett treningSpillere-oppføringer
    const tsSnap = await getDocs(
      query(collection(db, SAM.TS), where('spillerId', '==', spillerId))
    );
    for (const d of tsSnap.docs) await leggTil('delete', d.ref);

    await kommit();

    // Oppdater lokal tilstand
    app.spillere = app.spillere.filter(s => s.id !== spillerId);
    aktivSlettSpillerId = null;
    kampStatCache.delete(spillerId); // tøm cache for slettet spiller

    _sesongCache = null;
    visMelding('Spiller slettet.');
    naviger('spillere');
    oppdaterGlobalLedertavle();
  } catch (e) {
    console.error('[slettSpiller]', e);
    visFBFeil('Feil ved sletting: ' + (e?.message ?? e));
  }
}
window.utforSlettSpiller = utforSlettSpiller;

// ════════════════════════════════════════════════════════
// ØKTARKIV
// ════════════════════════════════════════════════════════
async function lastArkiv() {
  if (!db) { visMelding('Firebase ikke tilkoblet.', 'feil'); return; }
  const laster = document.getElementById('arkiv-laster');
  const liste  = document.getElementById('arkiv-liste');
  if (laster) laster.style.display = 'flex';
  if (liste)  liste.innerHTML = '';

  try {
    const snap = await getDocs(
      query(collection(db, SAM.TRENINGER), where('klubbId', '==', aktivKlubbId), orderBy('opprettetDato', 'desc'))
    );
    if (laster) laster.style.display = 'none';

    if (snap.empty) {
      if (liste) liste.innerHTML =
        '<div style="padding:20px;text-align:center;color:var(--muted2);font-size:16px">Ingen økter registrert ennå</div>';
      return;
    }

    if (liste) {
      liste.innerHTML = snap.docs.map((d, i) => {
        const t    = d.data();
        const dato = t.opprettetDato?.toDate?.() ?? null;
        const datoStr = dato
          ? dato.toLocaleDateString('nb-NO', { day:'numeric', month:'long', year:'numeric' })
          : 'Ukjent dato';
        const tidStr = dato
          ? dato.toLocaleTimeString('nb-NO', { hour:'2-digit', minute:'2-digit' })
          : '';
        const status  = t.status === 'aktiv' ? '● Aktiv' : 'Avsluttet';
        const statFarge = t.status === 'aktiv' ? 'var(--green2)' : 'var(--muted2)';
        const runder  = t.gjeldendRunde ?? 1;
        const maks    = t.maksRunder    ?? '?';
        const baner   = t.antallBaner   ?? '?';

        return `<div class="kort" style="cursor:pointer;margin-bottom:10px;active:opacity:.85" data-treningid="${d.id}" onclick="apneTreningsdetaljFraDom(this)">
          <div class="kort-hode" style="align-items:center">
            <div style="flex:1">
              <div style="font-family:'Bebas Neue',cursive;font-size:23px;letter-spacing:1px;color:var(--white)">
                Økt ${snap.docs.length - i}
              </div>
              <div style="font-size:15px;color:var(--muted2);margin-top:2px">${datoStr}${tidStr ? ' • ' + tidStr : ''}</div>
            </div>
            <div style="text-align:right;margin-right:10px">
              <div style="font-size:14px;color:${statFarge};font-weight:700">${status}</div>
              <div style="font-size:14px;color:var(--muted2);margin-top:2px">${baner} baner • ${runder}/${maks} runder</div>
            </div>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" style="flex-shrink:0"><path d="M9 18l6-6-6-6"/></svg>
          </div>
        </div>`;
      }).join('');
    }
  } catch (e) {
    if (laster) laster.style.display = 'none';
    visFBFeil('Kunne ikke laste arkiv: ' + (e?.message ?? e));
  }
}
window.lastArkiv = lastArkiv;

// Lagrer ID globalt — trygt mot anførselstegn-problemer i onclick
let aktivTreningDetaljId = null;
function apneTreningsdetaljFraDom(el) {
  aktivTreningDetaljId = el.dataset.treningid;
  apneTreningsdetalj(aktivTreningDetaljId);
}
window.apneTreningsdetaljFraDom = apneTreningsdetaljFraDom;

async function apneTreningsdetalj(treningId) {
  if (!db || !treningId) return;

  // Naviger og vis lastingsindikator
  document.getElementById('detalj-rangering').innerHTML =
    '<div class="laster"><div class="laster-snurr"></div>Laster resultater…</div>';
  document.getElementById('detalj-rating').innerHTML = '';
  document.getElementById('detalj-kamper').innerHTML =
    '<div class="laster"><div class="laster-snurr"></div>Laster kamper…</div>';
  naviger('treningsdetalj');

  try {
    const snap = await getDoc(doc(db, SAM.TRENINGER, treningId));
    if (!snap.exists()) { visMelding('Økt ikke funnet.', 'feil'); naviger('arkiv'); return; }
    const t       = snap.data();
    const dato    = t.opprettetDato?.toDate?.() ?? null;
    const erAktiv = t.status === 'aktiv';
    const erAuto  = t.autoAvsluttet === true;

    document.getElementById('detalj-tittel').textContent =
      erAktiv ? 'Pågående økt' : 'Avsluttet økt';
    document.getElementById('detalj-dato').textContent = dato
      ? dato.toLocaleDateString('nb-NO', { weekday:'short', day:'numeric', month:'long', year:'numeric' })
        + ' • ' + dato.toLocaleTimeString('nb-NO', { hour:'2-digit', minute:'2-digit' })
      : '';

    // Meta-chips
    const antallBaner    = t.antallBaner   ?? '?';
    const gjeldendRunde  = t.gjeldendRunde ?? 1;
    const maksRunder     = t.maksRunder    ?? '?';
    const poengPerKamp   = t.poengPerKamp  ?? '?';
    const antallSpillere = (t.baneOversikt ?? []).reduce((sum, b) => sum + (b.spillere?.length ?? 0), 0)
                         + (t.venteliste ?? []).length;
    const metaChips = [
      { ikon: '⛳', tekst: antallBaner + ' baner' },
      { ikon: '🔄', tekst: gjeldendRunde + '/' + maksRunder + ' runder' },
      { ikon: '👥', tekst: antallSpillere + ' deltakere' },
      { ikon: '🎯', tekst: poengPerKamp + ' poeng/kamp' },
    ];
    document.getElementById('detalj-meta').innerHTML = metaChips.map(c =>
      `<div style="display:inline-flex;align-items:center;gap:5px;padding:5px 10px;background:var(--navy3);border:1px solid var(--border);border-radius:20px;font-size:15px;color:var(--muted2)">
        <span style="font-size:16px">${c.ikon}</span>${c.tekst}
      </div>`
    ).join('');

    // Hent sluttresultater og alle kamper parallelt
    const [resSnap, kampSnap] = await Promise.all([
      getDocs(query(collection(db, SAM.RESULTATER), where('treningId', '==', treningId))),
      getDocs(query(collection(db, SAM.KAMPER),     where('treningId', '==', treningId))),
    ]);

    const resultater = resSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.sluttPlassering ?? 999) - (b.sluttPlassering ?? 999));

    const alleKamper = kampSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.rundeNr - b.rundeNr) || (a.baneNr ?? '').localeCompare(b.baneNr ?? '') || (a.kampNr - b.kampNr));

    // ── Sluttrangering og ratingendringer ────────────────
    if (resultater.length > 0) {
      document.getElementById('detalj-rangering').innerHTML = resultater.map(r => {
        const ini = (r.spillerNavn ?? '?').split(' ').map(w => w[0] ?? '').join('').slice(0,2).toUpperCase() || '?';
        return `<div class="lb-rad" style="cursor:default">
          <div class="lb-plass${r.sluttPlassering <= 3 ? ' topp3' : ''}">${r.sluttPlassering}</div>
          <div class="lb-avatar">${ini}</div>
          <div class="lb-navn">${escHtml(r.spillerNavn ?? 'Ukjent')}</div>
          <div style="text-align:right">
            <div style="font-family:'DM Mono',monospace;font-size:15px;color:var(--muted2)">${r.ratingEtter ?? '—'}</div>
            <div class="lb-endring ${(r.ratingEndring ?? 0) >= 0 ? 'pos' : 'neg'}">
              ${(r.ratingEndring ?? 0) >= 0 ? '+' : ''}${r.ratingEndring ?? 0}
            </div>
          </div>
        </div>`;
      }).join('');

      document.getElementById('detalj-rating').innerHTML = resultater.map(r => `
        <div class="lb-rad" style="cursor:default">
          <div style="flex:1;font-size:17px">${escHtml(r.spillerNavn ?? 'Ukjent')}</div>
          <div style="font-family:'DM Mono',monospace;font-size:15px;color:var(--muted2);margin-right:10px">
            ${r.ratingFor ?? STARTRATING} → ${r.ratingEtter ?? STARTRATING}
          </div>
          <div class="lb-endring ${(r.ratingEndring ?? 0) >= 0 ? 'pos' : 'neg'}">
            ${(r.ratingEndring ?? 0) >= 0 ? '+' : ''}${r.ratingEndring ?? 0}
          </div>
        </div>`).join('');

    } else if (erAktiv) {
      // Pågående økt — vis deltakere
      const baner = t.baneOversikt ?? [];
      const vl    = t.venteliste   ?? [];
      const runde = t.gjeldendRunde ?? 1;
      const maks  = t.maksRunder   ?? '?';
      let html = `<div style="padding:8px 0 12px;font-size:16px;color:var(--accent2);font-weight:600;display:flex;align-items:center;gap:8px">
        <div class="runde-prikk-live"></div>Runde ${runde} av ${maks} pågår
      </div>`;
      baner.forEach(bane => {
        html += `<div style="margin-bottom:14px">
          <div style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted2);margin-bottom:4px">Bane ${bane.baneNr}</div>`;
        (bane.spillere ?? []).forEach(s => {
          const ini = (s.navn ?? '?').split(' ').map(w => w[0] ?? '').join('').slice(0,2).toUpperCase() || '?';
          html += `<div class="lb-rad" style="cursor:default;padding:8px 0">
            <div class="lb-avatar" style="width:32px;height:32px;font-size:16px">${ini}</div>
            <div style="flex:1;font-size:17px">${escHtml(s.navn ?? 'Ukjent')}</div>
            <div style="font-family:'DM Mono',monospace;font-size:15px;color:var(--yellow)">⭐ ${s.rating ?? STARTRATING}</div>
          </div>`;
        });
        html += '</div>';
      });
      if (vl.length > 0) {
        html += `<div style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--orange);margin:8px 0 4px">Venteliste</div>`;
        vl.forEach(s => {
          const ini = (s.navn ?? '?').split(' ').map(w => w[0] ?? '').join('').slice(0,2).toUpperCase() || '?';
          html += `<div class="lb-rad" style="cursor:default;padding:8px 0">
            <div class="lb-avatar" style="width:32px;height:32px;font-size:16px;background:var(--orange)">${ini}</div>
            <div style="flex:1;font-size:17px">${escHtml(s.navn ?? 'Ukjent')}</div>
            <div style="font-family:'DM Mono',monospace;font-size:15px;color:var(--yellow)">⭐ ${s.rating ?? STARTRATING}</div>
          </div>`;
        });
      }
      document.getElementById('detalj-rangering').innerHTML = html;
      document.getElementById('detalj-rating').innerHTML =
        '<div style="padding:12px 0;text-align:center;font-size:16px;color:var(--muted2)">Ratingendringer beregnes når økten avsluttes av admin.</div>';
    } else {
      const melding = erAuto
        ? 'Økten ble avsluttet automatisk etter 5 timer. Ingen ratingendringer ble beregnet.'
        : 'Ingen resultater registrert for denne økten.';
      document.getElementById('detalj-rangering').innerHTML =
        `<div style="padding:20px;text-align:center;font-size:16px;color:var(--muted2)">${melding}</div>`;
      document.getElementById('detalj-rating').innerHTML = '';
    }

    // ── Kampresultater per runde og bane ─────────────────
    const ferdigeKamper = alleKamper.filter(k => k.ferdig && k.lag1Poeng != null && k.lag2Poeng != null);

    if (ferdigeKamper.length === 0) {
      document.getElementById('detalj-kamper').innerHTML =
        '<div style="padding:12px 0 0;text-align:center;font-size:15px;color:var(--muted2)">Ingen kampresultater registrert.</div>';
    } else {
      // Grupper: runde → bane
      const runder = {};
      ferdigeKamper.forEach(k => {
        const rNr = k.rundeNr ?? 1;
        const bNr = k.baneNr ?? 'bane?';
        if (!runder[rNr]) runder[rNr] = {};
        if (!runder[rNr][bNr]) runder[rNr][bNr] = [];
        runder[rNr][bNr].push(k);
      });

      let html = '';
      Object.keys(runder).sort((a,b) => Number(a)-Number(b)).forEach(rNr => {
        html += `<div style="font-size:13px;text-transform:uppercase;letter-spacing:2px;color:var(--accent2);font-weight:600;margin:14px 0 8px;display:flex;align-items:center;gap:8px">
          Runde ${rNr}<span style="flex:1;height:1px;background:var(--border);display:block"></span>
        </div>`;

        Object.keys(runder[rNr]).sort().forEach(bNr => {
          const baneNummer = bNr.replace('bane','');
          const kamper     = runder[rNr][bNr];
          html += `<div class="kort" style="margin-bottom:10px">
            <div class="kort-hode">
              <span style="font-family:'Bebas Neue',cursive;font-size:22px;color:var(--accent);letter-spacing:2px">${baneNummer}</span>
              <span style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted2)">Bane</span>
            </div>
            <div class="kort-innhold" style="padding:0">`;

          kamper.forEach(k => {
            const l1Navn = `${escHtml(k.lag1_s1_navn ?? '?')} + ${escHtml(k.lag1_s2_navn ?? '?')}`;
            const l2Navn = `${escHtml(k.lag2_s1_navn ?? '?')} + ${escHtml(k.lag2_s2_navn ?? '?')}`;
            const l1Vant = k.lag1Poeng > k.lag2Poeng;
            const l2Vant = k.lag2Poeng > k.lag1Poeng;
            const hvilerHTML = k.hviler_navn
              ? `<div style="font-size:13px;color:var(--orange);margin-top:4px">💤 ${escHtml(k.hviler_navn)} hvilte — fikk ${k.hvilerPoeng ?? '?'} poeng</div>`
              : '';
            html += `<div class="kamp-rad" style="padding:10px 16px">
              <div class="kamp-nummer" style="font-size:13px">K${k.kampNr}</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:15px;color:${l1Vant ? 'var(--white)' : 'var(--muted2)'};font-weight:${l1Vant ? '600' : '400'}">${l1Navn}</div>
                <div style="font-size:13px;color:var(--muted);margin:2px 0">mot</div>
                <div style="font-size:15px;color:${l2Vant ? 'var(--white)' : 'var(--muted2)'};font-weight:${l2Vant ? '600' : '400'}">${l2Navn}</div>
                ${hvilerHTML}
              </div>
              <div style="font-family:'DM Mono',monospace;font-size:20px;font-weight:700;flex-shrink:0;color:var(--green2)">${k.lag1Poeng}–${k.lag2Poeng}</div>
            </div>`;
          });

          html += '</div></div>';
        });
      });

      document.getElementById('detalj-kamper').innerHTML = html;
    }

  } catch (e) {
    console.error('[apneTreningsdetalj]', e);
    document.getElementById('detalj-rangering').innerHTML =
      '<div style="padding:16px;text-align:center;font-size:16px;color:var(--red2)">Feil ved lasting. Prøv igjen.</div>';
    document.getElementById('detalj-kamper').innerHTML = '';
    visFBFeil('Kunne ikke laste øktdetaljer: ' + (e?.message ?? e));
  }
}
window.apneTreningsdetalj = apneTreningsdetalj;

// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
// SLETT ØKT (admin)
// ════════════════════════════════════════════════════════
function visSlettOktModal() {
  if (!aktivTreningDetaljId) { visMelding('Ingen økt valgt.', 'feil'); return; }
  krevAdminMedDemo(
    'Slett økt',
    'Kun administrator kan slette lagrede økter.',
    () => {
      document.getElementById('modal-slett-okt').style.display = 'flex';
    }
  );
}
window.visSlettOktModal = visSlettOktModal;

async function utforSlettOkt() {
  const treningId = aktivTreningDetaljId;
  if (!db || !treningId) { visMelding('Ingen økt valgt.', 'feil'); return; }
  document.getElementById('modal-slett-okt').style.display = 'none';
  visMelding('Sletter økt…', 'advarsel');

  try {
    const BATCH_MAKS = 400;
    let batch  = writeBatch(db);
    let teller = 0;

    const kommit = async () => {
      if (teller > 0) { await batch.commit(); batch = writeBatch(db); teller = 0; }
    };
    const slettDoc = async (ref) => {
      batch.delete(ref);
      teller++;
      if (teller >= BATCH_MAKS) await kommit();
    };

    // 1. Slett treningsdokumentet
    await slettDoc(doc(db, SAM.TRENINGER, treningId));

    // 2. Slett alle kamper
    const kamperSnap = await getDocs(
      query(collection(db, SAM.KAMPER), where('treningId', '==', treningId))
    );
    for (const d of kamperSnap.docs) await slettDoc(d.ref);

    // 3. Slett treningSpillere
    const tsSnap = await getDocs(
      query(collection(db, SAM.TS), where('treningId', '==', treningId))
    );
    for (const d of tsSnap.docs) await slettDoc(d.ref);

    // 4. Slett resultater
    const resSnap = await getDocs(
      query(collection(db, SAM.RESULTATER), where('treningId', '==', treningId))
    );
    for (const d of resSnap.docs) await slettDoc(d.ref);

    // 5. Slett ratinghistorikk for denne økten
    const histSnap = await getDocs(
      query(collection(db, SAM.HISTORIKK), where('treningId', '==', treningId))
    );
    for (const d of histSnap.docs) await slettDoc(d.ref);

    await kommit();

    // Rydd opp sessionStorage om dette var aktiv økt
    if (sessionStorage.getItem('aktivTreningId') === treningId) {
      sessionStorage.removeItem('aktivTreningId');
      app.treningId = null;
    }
    aktivTreningDetaljId = null;

    visMelding('Økt slettet.');
    naviger('arkiv');
    lastArkiv();
  } catch (e) {
    console.error('[slettOkt]', e);
    visFBFeil('Feil ved sletting av økt: ' + (e?.message ?? e));
  }
}
window.utforSlettOkt = utforSlettOkt;

// ════════════════════════════════════════════════════════
// SLETT ALLE ØKTER (admin)
// ════════════════════════════════════════════════════════
async function visSlettAlleOkterModal() {
  if (!db) { visMelding('Firebase ikke tilkoblet.', 'feil'); return; }

  krevAdminMedDemo(
    'Slett alle økter',
    'Kun administrator kan slette alle lagrede økter.',
    async () => {
      // Tell opp antall økter før vi viser modalen
      try {
        const snap = await getDocs(collection(db, SAM.TRENINGER));
        const antall = snap.size;
        document.getElementById('slett-alle-teller').textContent =
          antall === 0
            ? 'Ingen lagrede økter funnet.'
            : `${antall} økt${antall === 1 ? '' : 'er'} vil bli slettet.`;
        document.getElementById('modal-slett-alle-okter').style.display = 'flex';
      } catch (e) {
        visFBFeil('Kunne ikke telle økter: ' + (e?.message ?? e));
      }
    }
  );
}
window.visSlettAlleOkterModal = visSlettAlleOkterModal;

async function utforSlettAlleOkter() {
  if (!db) { visMelding('Firebase ikke tilkoblet.', 'feil'); return; }
  document.getElementById('modal-slett-alle-okter').style.display = 'none';
  visMelding('Sletter alle økter… vennligst vent.', 'advarsel');

  try {
    const BATCH_MAKS = 400;
    let batch  = writeBatch(db);
    let teller = 0;

    const kommit = async () => {
      if (teller > 0) { await batch.commit(); batch = writeBatch(db); teller = 0; }
    };
    const slettDoc = async (ref) => {
      batch.delete(ref);
      teller++;
      if (teller >= BATCH_MAKS) await kommit();
    };

    // Hent alle trenings-IDer først
    const treningSnap = await getDocs(collection(db, SAM.TRENINGER));
    const treningIds  = treningSnap.docs.map(d => d.id);

    if (treningIds.length === 0) {
      visMelding('Ingen økter å slette.', 'advarsel');
      return;
    }

    // Slett alle treningsdokumenter
    for (const d of treningSnap.docs) await slettDoc(d.ref);

    // Slett alle undersamlinger (Firestore tillater maks 10 IDer i where-in)
    const samlingerMedTreningId = [SAM.KAMPER, SAM.TS, SAM.RESULTATER, SAM.HISTORIKK];

    for (const sam of samlingerMedTreningId) {
      // Del opp i grupper på 10 (Firestore 'in'-grense)
      for (let i = 0; i < treningIds.length; i += 10) {
        const gruppe = treningIds.slice(i, i + 10);
        const snap = await getDocs(
          query(collection(db, sam), where('treningId', 'in', gruppe))
        );
        for (const d of snap.docs) await slettDoc(d.ref);
      }
    }

    await kommit();

    // Rydd opp sessionStorage om aktiv økt var blant de slettede
    if (sessionStorage.getItem('aktivTreningId')) {
      sessionStorage.removeItem('aktivTreningId');
      app.treningId = null;
    }

    visMelding(`${treningIds.length} økt${treningIds.length === 1 ? '' : 'er'} slettet.`);
    naviger('arkiv');
    lastArkiv();
  } catch (e) {
    console.error('[slettAlleOkter]', e);
    visFBFeil('Feil ved sletting av alle økter: ' + (e?.message ?? e));
  }
}
window.utforSlettAlleOkter = utforSlettAlleOkter;

// NY ØKT
// ════════════════════════════════════════════════════════
function nyTrening() {
  stoppLyttere();
  app.valgtIds.clear();
  app.baneOversikt    = [];
  app.venteliste      = [];
  app.rangerteBAner   = [];
  app.ratingEndringer = [];
  app.runde           = 1;
  app.treningId       = null;
  app.aktivBane       = null;
  app.spillModus      = 'konkurranse'; // alltid tilbake til standard ved ny økt
  kampStatusCache     = {};
  kampStatCache.clear();
  _sesongCache        = null;
  // erAdmin nullstilles IKKE her — PIN gjelder fra opprettelse til avslutning av økt
  sessionStorage.removeItem('aktivTreningId');
  const sokEl = document.getElementById('sok-inndata');
  if (sokEl) sokEl.value = '';
  naviger('oppsett');
}
window.nyTrening = nyTrening;


// ════════════════════════════════════════════════════════
// AUTOMATISK AVSLUTNING — økter eldre enn 5 timer
// ════════════════════════════════════════════════════════
const AUTO_AVSLUTT_TIMER_MS = 5 * 60 * 60 * 1000; // 5 timer i millisekunder

/**
 * Sjekker alle aktive økter og avslutter de som er eldre enn 5 timer.
 * Kalles stille ved oppstart — brukeren ser ingenting med mindre noe faktisk avsluttes.
 * Ratingendringer beregnes IKKE (økten ble ikke offisielt avsluttet av admin).
 */
async function autoAvsluttGamleTreninger() {
  try {
    const snap = await getDocs(
      query(collection(db, SAM.TRENINGER), where('status', '==', 'aktiv'), where('klubbId', '==', aktivKlubbId))
    );
    if (snap.empty) return;

    const naaNaa = Date.now();

    for (const d of snap.docs) {
      const data          = d.data();
      const referanseDato = data.sisteAktivitetDato ?? data.opprettetDato;
      const referanseMs   = referanseDato?.toDate?.()?.getTime?.() ?? null;
      if (!referanseMs) continue;

      const alderMs = naaNaa - referanseMs;
      if (alderMs < AUTO_AVSLUTT_TIMER_MS) continue;

      // Økten er eldre enn 5 timer — avslutt automatisk
      console.info(`[AutoAvslutt] Avslutter økt ${d.id} (${Math.round(alderMs / 3600000)} timer gammel)`);

      try {
        await updateDoc(d.ref, {
          status:            'avsluttet',
          avsluttetDato:     serverTimestamp(),
          laast:             false,
          autoAvsluttet:     true,  // markerer at dette ikke var manuell avslutning
        });

        // Rydd opp sessionStorage om dette var vår egen økt
        if (sessionStorage.getItem('aktivTreningId') === d.id) {
          sessionStorage.removeItem('aktivTreningId');
        }
      } catch (e) {
        console.warn(`[AutoAvslutt] Kunne ikke avslutte ${d.id}:`, e?.message ?? e);
      }
    }
  } catch (e) {
    console.warn('[AutoAvslutt] Sjekk feilet:', e?.message ?? e);
  }
}

// ════════════════════════════════════════════════════════
// INIT — gjenoppretter aktiv økt fra Firestore ved oppstart
// ════════════════════════════════════════════════════════
async function gjenopprettTrening(treningId) {
  const snap = await getDoc(doc(db, SAM.TRENINGER, treningId));
  if (!snap.exists() || snap.data()?.status !== 'aktiv') return false;
  const data = snap.data();

  // Sjekk om økten er eldre enn 5 timer basert på sist registrerte aktivitet
  // (sisteAktivitetDato oppdateres ved hvert poengoppslag — eldre felt: opprettetDato)
  const referanseDato = data.sisteAktivitetDato ?? data.opprettetDato;
  const referanseMs   = referanseDato?.toDate?.()?.getTime?.() ?? null;
  if (referanseMs && (Date.now() - referanseMs) >= AUTO_AVSLUTT_TIMER_MS) {
    console.info(`[Init] Økt ${treningId} er for gammel — gjenoppretter ikke.`);
    visMelding('Økten er eldre enn 5 timer og ble ikke gjenopprettet.', 'advarsel');
    return false;
  }

  app.treningId         = treningId;
  app.runde             = data.gjeldendRunde    ?? 1;
  app.baneOversikt      = data.baneOversikt     ?? [];
  app.venteliste        = data.venteliste       ?? [];
  app.antallBaner       = data.antallBaner      ?? 3;
  app.poengPerKamp      = data.poengPerKamp     ?? 15;
  app.maksRunder        = data.maksRunder       ?? 4;
  app.er6SpillerFormat  = data.er6SpillerFormat ?? false;
  app.spillModus        = data.spillModus       ?? 'konkurranse';
  sessionStorage.setItem('aktivTreningId', treningId);
  try { history.replaceState(null, '', '?okt=' + treningId); } catch (_) {}
  oppdaterRundeUI();
  // Vis lastindikator mens kamp-lytteren henter data fra Firestore
  const baneLaster = document.getElementById('bane-laster');
  if (baneLaster) baneLaster.style.display = 'flex';
  startLyttere();
  naviger('baner');
  return true;
}


// ════════════════════════════════════════════════════════
// DEMO-DATA — seeder fiktive spillere og én avsluttet økt
// Kalles kun om demo-klubben ikke har spillere fra før
// ════════════════════════════════════════════════════════
const DEMO_SPILLERE = [
  { navn: 'Anna Larsen',    rating: 1120 },
  { navn: 'Bjørn Eriksen',  rating: 1085 },
  { navn: 'Camilla Dahl',   rating: 1043 },
  { navn: 'David Hansen',   rating: 1018 },
  { navn: 'Eva Nilsen',     rating:  982 },
  { navn: 'Fredrik Berg',   rating:  961 },
  { navn: 'Guro Andersen',  rating:  934 },
  { navn: 'Henrik Holm',    rating:  907 },
];

async function seedDemoDataOmNødvendig() {
  if (!db || aktivKlubbId !== 'demo') return;
  try {
    const snap = await getDocs(
      query(collection(db, SAM.SPILLERE), where('klubbId', '==', 'demo'), limit(1))
    );
    if (!snap.empty) return; // Demo-data finnes allerede

    console.info('[Demo] Seeder demo-data…');
    const batch = writeBatch(db);

    // Opprett spillere
    const spillerRefs = DEMO_SPILLERE.map(s => {
      const ref = doc(collection(db, SAM.SPILLERE));
      batch.set(ref, { navn: s.navn, rating: s.rating, klubbId: 'demo', opprettetDato: serverTimestamp() });
      return { ref, ...s };
    });

    // Opprett én avsluttet økt
    const treningRef = doc(collection(db, SAM.TRENINGER));
    batch.set(treningRef, {
      klubbId:       'demo',
      antallBaner:   2,
      poengPerKamp:  15,
      maksRunder:    3,
      gjeldendRunde: 3,
      status:        'avsluttet',
      laast:         false,
      spillModus:    'konkurranse',
      er6SpillerFormat: false,
      opprettetDato: serverTimestamp(),
      avsluttetDato: serverTimestamp(),
      baneOversikt:  [],
      venteliste:    [],
    });

    // Resultater per spiller
    const plasSorted = [...spillerRefs].sort((a, b) => b.rating - a.rating);
    plasSorted.forEach((s, i) => {
      const endring = [18, 12, 7, 3, -3, -7, -12, -18][i] ?? 0;
      batch.set(doc(collection(db, SAM.RESULTATER)), {
        treningId:       treningRef.id,
        klubbId:         'demo',
        spillerId:       s.ref.id,
        spillerNavn:     s.navn,
        sluttPlassering: i + 1,
        ratingFor:       s.rating - endring,
        ratingEtter:     s.rating,
        ratingEndring:   endring,
        spillModus:      'konkurranse',
        dato:            serverTimestamp(),
      });
      batch.set(doc(collection(db, SAM.HISTORIKK)), {
        spillerId:   s.ref.id,
        klubbId:     'demo',
        treningId:   treningRef.id,
        ratingFor:   s.rating - endring,
        ratingEtter: s.rating,
        endring,
        plassering:  i + 1,
        dato:        serverTimestamp(),
      });
    });

    await batch.commit();
    console.info('[Demo] Demo-data seeded OK');
  } catch (e) {
    console.warn('[Demo] Seeding feilet:', e?.message ?? e);
  }
}


// ════════════════════════════════════════════════════════
// AVBRYT ØKT — kun tilgjengelig i runde 1 uten registrerte poeng
// Sletter økten og sender tilbake til oppsett med spillerlisten intakt
// ════════════════════════════════════════════════════════

function oppdaterAvbrytKnapp() {
  const knapp = document.getElementById('avbryt-runde1-knapp');
  if (!knapp) return;
  // Vis kun i runde 1 og ingen poeng er registrert ennå
  const ingenPoeng = Object.values(kampStatusCache).every(k => !k.ferdig);
  knapp.style.display = (app.runde === 1 && ingenPoeng) ? 'inline-flex' : 'none';
}

function visAvbrytOktModal() {
  krevAdminMedDemo('Avbryt økt', 'Kun administrator kan avbryte økten.', () => {
    document.getElementById('modal-avbryt-okt').style.display = 'flex';
  });
}
window.visAvbrytOktModal = visAvbrytOktModal;

async function utforAvbrytOkt() {
  document.getElementById('modal-avbryt-okt').style.display = 'none';
  if (!db || !app.treningId) return;

  try {
    // Lås treningsdokumentet først — forhindrer at andre skriver til økten
    // mens vi sletter den. lassTrening kaster om økten allerede er låst.
    await lassTrening(null);

    // Hent alle relaterte dokumenter parallelt for å spare tid
    const [kampSnap, tsSnap] = await Promise.all([
      getDocs(query(collection(db, SAM.KAMPER), where('treningId', '==', app.treningId))),
      getDocs(query(collection(db, SAM.TS),     where('treningId', '==', app.treningId))),
    ]);

    // Bygg og commit én enkelt batch.
    // writeBatch er atomær — enten slettes alt, eller ingenting.
    // Treningsdokumentet slettes sist som naturlig barriere:
    // om batch feiler halvveis vil treningsdokumentet fortsatt eksistere
    // og neste forsøk vil finne og rydde opp de gjenværende dokumentene.
    const batch = writeBatch(db);
    kampSnap.docs.forEach(d => batch.delete(d.ref));
    tsSnap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(doc(db, SAM.TRENINGER, app.treningId));
    await batch.commit();

    // Nullstill app-tilstand men behold spillerlisten og valgte spillere
    const bevarteValgte = new Set(app.valgtIds);
    stoppLyttere();
    sessionStorage.removeItem('aktivTreningId');
    try { history.replaceState(null, '', location.pathname); } catch (_) {}

    app.treningId    = null;
    app.baneOversikt = [];
    app.venteliste   = [];
    app.runde        = 1;
    kampStatusCache  = {};
    setErAdmin(false);

    // Gjenopprett valgte spillere
    app.valgtIds = bevarteValgte;

    visMelding('Økt avbrutt — du er tilbake på oppsett.');
    naviger('oppsett');
    visSpillere();

    // Bygg cache fra valgte spillere og åpne listen
    _sisteDeltakereCache = {
      spillerIds: [...bevarteValgte],
      hentetMs: Date.now(),
    };
    _sisteDeltakereApen = false;
    setTimeout(() => {
      if (!_sisteDeltakereApen) toggleSisteDeltakere();
    }, 300);

  } catch (e) {
    visFBFeil('Kunne ikke avbryte økt: ' + (e?.message ?? e));
  }
}
window.utforAvbrytOkt = utforAvbrytOkt;

async function init() {
  // Koble admin.js til app-spesifikk PIN-logikk
  registrerPinGetter(() => getAdminPin() ?? '');

  // Koble ui.js til app-spesifikk logikk
  registrerNavigertHandler(skjerm => {
    if (skjerm === 'baner')    visBaner();
    if (skjerm === 'slutt')    visSluttresultat();
    if (skjerm === 'spillere') oppdaterGlobalLedertavle();
    if (skjerm === 'arkiv')    lastArkiv();
    if (skjerm === 'hjem')     visHjemStatus();
  });
  registrerBeforeunload(() => !!app.treningId);

  if (!db) {
    visFBFeil('Firebase er ikke konfigurert. Oppdater FB_CONFIG øverst i skriptet.');
    return;
  }

  // Vis hjemskjerm alltid ved oppstart — bruker velger klubb der
  naviger('hjem');
  return;
}

async function initEtterKlubbValg() {
  if (!db || !aktivKlubbId) return;

  // Seed demo-data om nødvendig (kjører kun for demo-klubben og kun én gang)
  await seedDemoDataOmNødvendig();

  lyttPaaSpillere();

  // Kjør auto-avslutning stille i bakgrunnen — blokkerer ikke oppstarten
  autoAvsluttGamleTreninger();

  try {
    // Steg 0: sjekk URL-parameter ?okt= (delt lenke)
    const urlParams = new URLSearchParams(location.search);
    const urlOktId = urlParams.get('okt');
    if (urlOktId) {
      const ok = await gjenopprettTrening(urlOktId);
      if (ok) { visMelding('Koblet til økt!'); return; }
      // Ugyldig/gammel økt-ID i URL — fortsett normalt
      try { history.replaceState(null, '', location.pathname); } catch (_) {}
    }

    // Steg 1: prøv sessionStorage (raskest — unngår unødvendig Firestore-kall)
    const lagretId = sessionStorage.getItem('aktivTreningId');
    if (lagretId) {
      const ok = await gjenopprettTrening(lagretId);
      if (ok) { visMelding('Økt gjenopprettet'); return; }
      sessionStorage.removeItem('aktivTreningId');
    }

    // Steg 2: søk i Firestore etter nyeste aktive økt
    // (fanger opp tilfeller der sessionStorage er tom — ny fane, annen enhet, osv.)
    // Merk: ingen orderBy her — unngår krav om sammensatt Firestore-indeks.
    // Det skal aldri være mer enn én aktiv økt av gangen.
    const aktivSnap = await getDocs(
      query(
        collection(db, SAM.TRENINGER),
        where('status', '==', 'aktiv'),
        where('klubbId', '==', aktivKlubbId),
        limit(1)
      )
    );

    if (!aktivSnap.empty) {
      const treningId = aktivSnap.docs[0].id;
      const ok = await gjenopprettTrening(treningId);
      if (ok) { visMelding('Økt gjenopprettet'); return; }
      // Økt finnes men ble avvist (for gammel) — meldingen er allerede vist
    }
  } catch (e) {
    console.warn('Gjenoppretting feilet:', e?.message ?? e);
    sessionStorage.removeItem('aktivTreningId');
    visMelding('Kunne ikke gjenopprette økt: ' + (e?.message ?? 'ukjent feil'), 'feil');
  }

  // Ingen aktiv økt funnet — vis baneoversikt (vi er allerede på hjem)
  try { history.replaceState(null, '', location.pathname); } catch (_) {}
}

init();

// Når bruker kommer tilbake til appen etter å ha hatt den i bakgrunnen,
// sjekk om runden har endret seg eller økten er avsluttet.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (!db || !app.treningId) return;
  try {
    const snap = await getDoc(doc(db, SAM.TRENINGER, app.treningId));
    if (!snap.exists()) return;
    const data = snap.data() ?? {};

    // Økt avsluttet av admin mens bruker var borte
    if (data.status === 'avsluttet') {
      if (app.treningId) sessionStorage.setItem('aktivTreningId', app.treningId);
      stoppLyttere();
      naviger('slutt');
      return;
    }

    // Ny runde startet av admin mens bruker var borte
    const nyRunde = data.gjeldendRunde ?? app.runde;
    if (nyRunde > app.runde) {
      app.runde = nyRunde;
      oppdaterRundeUI();
      startKampLytter();
      visBanerDebounced();
      naviger('baner');
    }
  } catch (_) {}
});
