// ════════════════════════════════════════════════════════
// rating.js — Elo-beregning og nivå-fargekoding
// ════════════════════════════════════════════════════════

import { STARTRATING } from './firebase.js';

// ════════════════════════════════════════════════════════
// NIVÅ-FARGEKODING
// ════════════════════════════════════════════════════════
const NIVAA_TERSKLER = { lav: 950, hoey: 1050 };

export function getNivaaKlasse(rating) {
  const r = typeof rating === 'number' ? rating : STARTRATING;
  if (r < NIVAA_TERSKLER.lav)  return 'nivaa-lav';
  if (r > NIVAA_TERSKLER.hoey) return 'nivaa-hoey';
  return 'nivaa-mid';
}

export function getNivaaLabel(rating) {
  const kl  = getNivaaKlasse(rating);
  const map = {
    'nivaa-lav':  { ikon: '🔴', tekst: 'Ny'      },
    'nivaa-mid':  { ikon: '🟡', tekst: 'Middels'  },
    'nivaa-hoey': { ikon: '🟢', tekst: 'Sterk'    },
  };
  return { ...map[kl], kl };
}

export function getNivaaRatingHTML(rating, visLabel = true) {
  const kl    = getNivaaKlasse(rating);
  const label = getNivaaLabel(rating);
  const labelHTML = visLabel
    ? `<span class="nivaa-label ${kl}">${label.ikon} ${label.tekst}</span>`
    : '';
  return `<span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap">
    <span class="${kl}"><span class="nivaa-dot"></span><span class="nivaa-rating">${rating ?? STARTRATING}</span></span>
    ${labelHTML}
  </span>`;
}

// ════════════════════════════════════════════════════════
// ELO-RATING
// ════════════════════════════════════════════════════════
const ELO_K = 20; // K-faktor — høyere = raskere ratingendring

/**
 * Beregner forventet score for lagA mot lagB (Elo-formel).
 */
export function eloForventet(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Oppdaterer rating for én kamp og returnerer endringene.
 * @param {Array}  lagA   — [{ id, rating }, ...]
 * @param {Array}  lagB   — [{ id, rating }, ...]
 * @param {number} scoreA
 * @param {number} scoreB
 * @param {number} [K]    — valgfri K-faktor
 * @returns {Object}      — { [spillerId]: ratingEndring }
 */
export function oppdaterRatingForKamp(lagA, lagB, scoreA, scoreB, K = ELO_K) {
  if (!lagA?.length || !lagB?.length) return {};
  const totalPoeng = (scoreA ?? 0) + (scoreB ?? 0);
  if (totalPoeng <= 0) return {};

  const ratingA = lagA.reduce((s, p) => s + (Number(p.rating) || STARTRATING), 0) / lagA.length;
  const ratingB = lagB.reduce((s, p) => s + (Number(p.rating) || STARTRATING), 0) / lagB.length;

  const forventetA = eloForventet(ratingA, ratingB);
  const forventetB = 1 - forventetA;

  // Binær score: vinn=1, tap=0, uavgjort=0.5
  // Alternativ: bruk scoreA/(scoreA+scoreB) for gradert score
  const faktiskA = scoreA > scoreB ? 1 : scoreA < scoreB ? 0 : 0.5;
  const faktiskB = 1 - faktiskA;

  const endringA = Math.round(K * (faktiskA - forventetA));
  const endringB = Math.round(K * (faktiskB - forventetB));

  const resultat = {};
  lagA.forEach(p => { if (p?.id) resultat[p.id] = (resultat[p.id] ?? 0) + endringA; });
  lagB.forEach(p => { if (p?.id) resultat[p.id] = (resultat[p.id] ?? 0) + endringB; });
  return resultat;
}

/**
 * Kjører Elo-beregning over alle kamper i en økt sekvensielt.
 * Ratingene oppdateres kamp for kamp slik at hver kamp
 * reflekterer spillernes faktiske rating på det tidspunktet.
 *
 * @param {Array} alleKamper    — alle ferdigspilte kamper for hele økten
 * @param {Array} spillereListe — [{ id, rating }] med startrating
 * @returns {Object}            — { [spillerId]: { startRating, nyRating, endring } }
 */
export function beregnEloForOkt(alleKamper, spillereListe) {
  const ratingNaa = {};
  spillereListe.forEach(s => {
    ratingNaa[s.id] = Number(s.rating) || STARTRATING;
  });

  const sorterte = [...alleKamper]
    .filter(k => k?.ferdig && k.lag1Poeng != null && k.lag2Poeng != null)
    .sort((a, b) => (a.rundeNr - b.rundeNr)
      || (a.baneNr ?? '').localeCompare(b.baneNr ?? '')
      || (a.kampNr - b.kampNr));

  for (const kamp of sorterte) {
    const lagA = [
      { id: kamp.lag1_s1, rating: ratingNaa[kamp.lag1_s1] ?? STARTRATING },
      kamp.lag1_s2 ? { id: kamp.lag1_s2, rating: ratingNaa[kamp.lag1_s2] ?? STARTRATING } : null,
    ].filter(p => p?.id);

    const lagB = [
      { id: kamp.lag2_s1, rating: ratingNaa[kamp.lag2_s1] ?? STARTRATING },
      kamp.lag2_s2 ? { id: kamp.lag2_s2, rating: ratingNaa[kamp.lag2_s2] ?? STARTRATING } : null,
    ].filter(p => p?.id);

    const endringer = oppdaterRatingForKamp(lagA, lagB, kamp.lag1Poeng, kamp.lag2Poeng);
    Object.entries(endringer).forEach(([id, delta]) => {
      if (id in ratingNaa) ratingNaa[id] += delta;
    });
  }

  const resultat = {};
  spillereListe.forEach(s => {
    const startRating = Number(s.rating) || STARTRATING;
    const nyRating    = Math.max(1, Math.round(ratingNaa[s.id] ?? startRating));
    resultat[s.id] = { startRating, nyRating, endring: nyRating - startRating };
  });
  return resultat;
}

/**
 * Trend basert på siste 5 økt-resultater.
 * @param {Array} historikk — sortert stigende (eldste først)
 */
export function beregnTrend(historikk) {
  if (!historikk?.length) return { trend: 'stable', change: 0 };
  const siste5 = historikk.slice(-5);
  const change = siste5.reduce((sum, h) => sum + (h.endring ?? 0), 0);
  return { trend: change > 0 ? 'up' : change < 0 ? 'down' : 'stable', change };
}
