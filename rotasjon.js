// ════════════════════════════════════════════════════════
// rotasjon.js — Banefordeling og kampoppsett
// Håndterer americano-rotasjon for 4, 5 og 6 spillere,
// og Mix & Match matchmaking.
// ════════════════════════════════════════════════════════

import { STARTRATING, PARTER, PARTER_5, PARTER_6_DOBBEL, PARTER_6_SINGEL } from './firebase.js';

// ════════════════════════════════════════════════════════
// HJELPER
// ════════════════════════════════════════════════════════
export function getParter(antall, erSingel = false) {
  if (antall === 5)            return PARTER_5;
  if (antall === 2 || erSingel) return PARTER_6_SINGEL;
  return PARTER;
}

/** Fisher-Yates shuffle */
export function blandArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Gir poeng til spillere i en kamp, inkl. hviler-logikk for 5-spillerbaner.
 */
export function beregnPoengForKamp(par, spillere, lag1Poeng, lag2Poeng) {
  const res = [];
  par.lag1.forEach(i => {
    if (spillere[i]) res.push({ spillerId: spillere[i].id, poeng: lag1Poeng });
  });
  par.lag2.forEach(i => {
    if (spillere[i]) res.push({ spillerId: spillere[i].id, poeng: lag2Poeng });
  });
  if (par.hviler != null && spillere[par.hviler]) {
    const hvilPoeng = Math.ceil((lag1Poeng + lag2Poeng) / 2);
    res.push({ spillerId: spillere[par.hviler].id, poeng: hvilPoeng });
  }
  return res;
}

// ════════════════════════════════════════════════════════
// KONKURRANSE — BANEFORDELING
// ════════════════════════════════════════════════════════

/**
 * Fordeler spillere på baner med 4 eller 5 per bane.
 * Sorterer etter rating og bruker 5-spillerbaner der antallet ikke går opp i 4.
 */
export function fordelBaner(spillere, antallBaner, poengPerKamp = 17) {
  if (!spillere?.length) return [];
  const sorterte = [...spillere].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const n = sorterte.length;

  // ── 6-SPILLER SPESIALFORMAT ──
  if (n === 6 && antallBaner === 2) {
    const mp = poengPerKamp;
    const sinSpl = [sorterte[2], sorterte[3]].map(s => ({ id:s.id, navn:s.navn??'Ukjent', rating:s.rating??STARTRATING }));
    const dblSpl = [sorterte[0], sorterte[5], sorterte[1], sorterte[4]].map(s => ({ id:s.id, navn:s.navn??'Ukjent', rating:s.rating??STARTRATING }));
    return [
      { baneNr: 1, erDobbel: true,  erSingel: false, maksPoeng: mp, spillere: dblSpl },
      { baneNr: 2, erDobbel: false, erSingel: true,  maksPoeng: mp, spillere: sinSpl },
    ];
  }

  const antall5 = n % 4;
  const baneStorr = [];
  for (let i = 0; i < antall5; i++) baneStorr.push(5);
  const totBaner = antall5 + Math.floor((n - antall5 * 5) / 4);
  for (let i = antall5; i < totBaner; i++) baneStorr.push(4);

  const mp  = poengPerKamp;
  const mp5 = Math.round(mp * 3 / 5);
  const baner = [];
  let cursor = 0;
  baneStorr.forEach((storr, i) => {
    baner.push({
      baneNr:    i + 1,
      maksPoeng: storr === 5 ? mp5 : mp,
      spillere:  sorterte.slice(cursor, cursor + storr).map(s => ({
        id: s.id, navn: s.navn ?? 'Ukjent', rating: s.rating ?? STARTRATING,
      })),
    });
    cursor += storr;
  });
  return baner;
}

// ════════════════════════════════════════════════════════
// MIX & MATCH — MATCHMAKING
// ════════════════════════════════════════════════════════

function _mixParCost(a, b, playedWith) {
  return ((playedWith[a.id]?.[b.id] ?? 0) + (playedWith[b.id]?.[a.id] ?? 0)) * 10;
}

function _mixMatchCost(t1, t2, pa) {
  const vs = (x, y) => (pa[x.id]?.[y.id] ?? 0) + (pa[y.id]?.[x.id] ?? 0);
  return vs(t1[0], t2[0]) + vs(t1[0], t2[1]) + vs(t1[1], t2[0]) + vs(t1[1], t2[1]);
}

function velgAktiveOgHvilere(spillere, gamesPlayed, sitOutCount, lastSitOutRunde, plasser, runde) {
  if (spillere.length <= plasser) return { aktive: [...spillere], hviler: [] };

  const sortert = spillere.map(s => ({
    s,
    kost: (gamesPlayed[s.id] ?? 0) * 10
        - (sitOutCount[s.id] ?? 0) * 8
        - (runde - (lastSitOutRunde[s.id] ?? 0)) * 3
        + Math.random() * 0.5,
  })).sort((a, b) => a.kost - b.kost);

  return {
    aktive: sortert.slice(0, plasser).map(x => x.s),
    hviler: sortert.slice(plasser).map(x => x.s),
  };
}

/**
 * Lager kampoppsett for én runde av Mix & Match.
 * @returns {{ baneOversikt, hviler }}
 */
export function lagMixKampoppsett(spillere, playedWith, playedAgainst, gamesPlayed, sitOutCount, lastSitOutRunde, antallBaner, runde, mp) {
  if (!spillere?.length) return { baneOversikt: [], hviler: [] };

  const poengPerKamp = mp ?? 15;
  const plasser      = antallBaner * 4;

  const { aktive, hviler } = velgAktiveOgHvilere(spillere, gamesPlayed, sitOutCount, lastSitOutRunde, plasser, runde);
  if (aktive.length < 4) return { baneOversikt: [], hviler };

  // Bygg par: greedy, minimiser partner-gjentak
  const pool  = blandArray([...aktive]);
  const brukt = new Set();
  const par   = [];

  for (const sp of pool) {
    if (brukt.has(sp.id)) continue;
    brukt.add(sp.id);
    let best = null, bestKost = Infinity;
    for (const k of pool) {
      if (brukt.has(k.id)) continue;
      const kost = _mixParCost(sp, k, playedWith) + Math.random() * 2;
      if (kost < bestKost) { bestKost = kost; best = k; }
    }
    if (best) { brukt.add(best.id); par.push([sp, best]); }
  }

  if (par.length < 2) return { baneOversikt: [], hviler };

  // Sett par mot hverandre: minimiser motstander-gjentak
  const bruktPar = new Set();
  const kamper   = [];

  for (let i = 0; i < par.length; i++) {
    if (bruktPar.has(i)) continue;
    bruktPar.add(i);
    let bestJ = -1, bestKost = Infinity;
    for (let j = i + 1; j < par.length; j++) {
      if (bruktPar.has(j)) continue;
      const kost = _mixMatchCost(par[i], par[j], playedAgainst) + Math.random() * 2;
      if (kost < bestKost) { bestKost = kost; bestJ = j; }
    }
    if (bestJ >= 0) { bruktPar.add(bestJ); kamper.push({ t1: par[i], t2: par[bestJ] }); }
  }

  const baneOversikt = kamper.slice(0, antallBaner).map((k, i) => ({
    baneNr:    i + 1,
    maksPoeng: poengPerKamp,
    spillere:  [...k.t1, ...k.t2].map(s => ({
      id:     s.id,
      navn:   s.navn   ?? 'Ukjent',
      rating: s.rating ?? STARTRATING,
    })),
  }));

  return { baneOversikt, hviler };
}

/** Oppdaterer Mix-statistikk in-place etter en runde. */
export function oppdaterMixStatistikk(baneOversikt, hvilerDenne, playedWith, playedAgainst, gamesPlayed, sitOutCount, lastSitOutRunde, rundeNr) {
  baneOversikt.forEach(({ spillere: [a, b, c, d] }) => {
    if (!a || !b || !c || !d) return;

    const incPW = (x, y) => {
      if (!playedWith[x.id]) playedWith[x.id] = {};
      if (!playedWith[y.id]) playedWith[y.id] = {};
      playedWith[x.id][y.id] = (playedWith[x.id][y.id] ?? 0) + 1;
      playedWith[y.id][x.id] = (playedWith[y.id][x.id] ?? 0) + 1;
    };
    const incPA = (x, y) => {
      if (!playedAgainst[x.id]) playedAgainst[x.id] = {};
      if (!playedAgainst[y.id]) playedAgainst[y.id] = {};
      playedAgainst[x.id][y.id] = (playedAgainst[x.id][y.id] ?? 0) + 1;
      playedAgainst[y.id][x.id] = (playedAgainst[y.id][x.id] ?? 0) + 1;
    };

    incPW(a, b); incPW(c, d);
    incPA(a, c); incPA(a, d);
    incPA(b, c); incPA(b, d);
    [a, b, c, d].forEach(s => { gamesPlayed[s.id] = (gamesPlayed[s.id] ?? 0) + 1; });
  });

  (hvilerDenne ?? []).forEach(s => {
    sitOutCount[s.id]     = (sitOutCount[s.id]     ?? 0) + 1;
    lastSitOutRunde[s.id] = rundeNr;
  });
}

/** Henter Mix-statistikk fra Firestore-treningsdokument. */
export function hentMixStatistikk(treningData) {
  return {
    playedWith:      treningData?.mixPlayedWith      ?? {},
    playedAgainst:   treningData?.mixPlayedAgainst   ?? {},
    gamesPlayed:     treningData?.mixGamesPlayed     ?? {},
    sitOutCount:     treningData?.mixSitOutCount     ?? {},
    lastSitOutRunde: treningData?.mixLastSitOutRunde ?? {},
  };
}

/** Runde 1 — ingen statistikk ennå. */
export function fordelBanerMix(spillere, antallBaner, poengPerKamp = 15) {
  return lagMixKampoppsett(spillere, {}, {}, {}, {}, {}, antallBaner, 1, poengPerKamp);
}

/**
 * Genererer neste runde for 6-spiller-format.
 */
export function neste6SpillerRunde(dobbelKamp, singelSpillere) {
  const { lag1, lag2, vinnerId } = dobbelKamp;
  const vinnere = vinnerId === 2 ? lag2 : lag1;
  const tapere  = vinnerId === 2 ? lag1 : lag2;
  const singelPar = tapere;

  const [vHøy, vLav] = [...vinnere].sort((a, b) => (b.rating ?? STARTRATING) - (a.rating ?? STARTRATING));
  const [sHøy, sLav] = [...singelSpillere].sort((a, b) => (b.rating ?? STARTRATING) - (a.rating ?? STARTRATING));

  return {
    dobbelLag1: [vHøy, sLav],
    dobbelLag2: [vLav, sHøy],
    singelPar,
  };
}
