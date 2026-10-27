// =============================================================
// ytelse.js: de rene delene av at køtavla ikke bygger hele tavla på nytt.
//
// Fila er både et CommonJS-modul (vitest, lib/__tests__/koTavleYtelse.test.ts, og ko-tavle.mjs via require) og
// et skript i nettleseren (ko-tavle.mjs serverer den som /ytelse.js, og den setter window.KoYtelse), så tavla bruker
// nøyaktig den koden testene sjekker. Ingen DOM her.
//
//   - Diffen: gammel liste (nøkkel → signatur) og ny liste gir operasjonene gjenbruk, bygg og fjern.
//   - Kortbufferen: tavla spør etter noden til et kort med nøkkel og signatur; samme signatur som sist gir samme
//     node (gjenbruk), ellers bygges den. Etter en runde ryddes kortene som ikke ble brukt (diffens «fjern»).
//   - Tastaturet (roving tabindex): hvor pil opp/ned, venstre/høyre, Home og End går mellom kort og kolonner.
//   - Komprimering: om et svar skal sendes med brotli, gzip eller ukomprimert (serveren, ko-tavle.mjs send()).
// =============================================================
(function (rot, fabrikk) {
  if (typeof module === 'object' && module.exports) module.exports = fabrikk();
  else rot.KoYtelse = fabrikk();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- Diffen ----

  /**
   * Gammel og ny liste gir operasjonene. `gamle` er en Map nøkkel → signatur (det som står bygget nå), `nye` er
   * [nøkkel, signatur]-par i rekkefølgen tavla trenger dem. En nøkkel med samme signatur gjenbrukes; en ny eller
   * endret nøkkel bygges; en gammel nøkkel som ikke er med lenger fjernes. Står en nøkkel to ganger i den nye
   * lista, bygges den andre forekomsten (én DOM-node kan bare stå ett sted).
   */
  function planlegg(gamle, nye) {
    const gjenbruk = [];
    const bygg = [];
    const sett = new Set();
    for (const [nokkel, signatur] of nye) {
      if (sett.has(nokkel)) {
        bygg.push(nokkel);
        continue;
      }
      sett.add(nokkel);
      if (gamle.has(nokkel) && gamle.get(nokkel) === signatur) gjenbruk.push(nokkel);
      else bygg.push(nokkel);
    }
    const fjern = [];
    for (const nokkel of gamle.keys()) if (!sett.has(nokkel)) fjern.push(nokkel);
    return { gjenbruk, bygg, fjern };
  }

  // ---- Kortbufferen ----

  /**
   * Bufferen tavla henter kortnodene fra. Én runde per tegning: `start()`, så `node(nokkel, signatur, bygg)` per
   * kort, så `slutt()`. `node` gir den lagrede noden når signaturen er den samme som sist (og nøkkelen ikke alt er
   * brukt i runden), ellers bygges en ny med `bygg()`. `slutt()` fjerner nodene som ikke ble brukt (diffens
   * «fjern») og returnerer tellerne. Et kort som bygges etter `slutt()` (en seksjon som åpnes) regnes til runden
   * som nettopp var, så det blir værende til neste tegning.
   */
  function lagKortBuffer() {
    const lager = new Map(); // nøkkel → { signatur, node }
    let runde = [];
    let brukt = new Set();
    let gjenbrukt = 0;
    let bygget = 0;
    return {
      start() {
        runde = [];
        brukt = new Set();
        gjenbrukt = 0;
        bygget = 0;
      },
      node(nokkel, signatur, bygg) {
        runde.push([nokkel, signatur]);
        const lagret = lager.get(nokkel);
        if (!brukt.has(nokkel) && lagret && lagret.signatur === signatur) {
          brukt.add(nokkel);
          gjenbrukt++;
          return lagret.node;
        }
        const node = bygg();
        bygget++;
        // En nøkkel som alt er brukt i runden, står et annet sted: den nye noden lagres ikke over den.
        if (!brukt.has(nokkel)) lager.set(nokkel, { signatur, node });
        brukt.add(nokkel);
        return node;
      },
      slutt() {
        const gamle = new Map([...lager].map(([n, x]) => [n, x.signatur]));
        const { fjern } = planlegg(gamle, runde);
        for (const n of fjern) lager.delete(n);
        return { gjenbrukt, bygget, fjernet: fjern.length };
      },
      storrelse: () => lager.size,
    };
  }

  // ---- Tastaturet (roving tabindex) ----

  /**
   * Hvor fokus skal når `tast` trykkes på kort nr. `i` i kolonne (eller celle) nr. `o`. `antall` er antall synlige
   * kort per kolonne, i rekkefølge fra venstre. Pil opp og ned går innen kolonnen og stopper i endene; Home og End
   * går til første og siste kort; pil venstre og høyre går til nærmeste kolonne med kort og holder plassen så langt
   * den kolonnen rekker. Returnerer { o, i }, eller null når tasten ikke flytter fokus.
   */
  function rovingMaal(antall, o, i, tast) {
    const n = antall[o] ?? 0;
    if (!n) return null;
    if (tast === 'ArrowDown') return i + 1 < n ? { o, i: i + 1 } : null;
    if (tast === 'ArrowUp') return i > 0 ? { o, i: i - 1 } : null;
    if (tast === 'Home') return { o, i: 0 };
    if (tast === 'End') return { o, i: n - 1 };
    if (tast === 'ArrowRight' || tast === 'ArrowLeft') {
      const steg = tast === 'ArrowRight' ? 1 : -1;
      for (let j = o + steg; j >= 0 && j < antall.length; j += steg)
        if (antall[j] > 0) return { o: j, i: Math.min(i, antall[j] - 1) };
      return null;
    }
    return null;
  }

  // ---- Komprimering (serveren) ----

  /** Svar under denne størrelsen sendes ukomprimert (komprimeringen koster mer enn den sparer). */
  const KOMPRIMER_FRA = 50 * 1024;

  /**
   * Kodingen for et svar på `bytes` byte når klienten sendte Accept-Encoding `acceptEncoding`: 'br' når brotli er
   * godtatt, ellers 'gzip', ellers null (ukomprimert). q=0 betyr «ikke godtatt»; «*» godtar gzip.
   */
  function velgKoding(acceptEncoding, bytes) {
    if (!(bytes > KOMPRIMER_FRA) || !acceptEncoding) return null;
    const q = new Map();
    for (const del of String(acceptEncoding).toLowerCase().split(',')) {
      const [navn, ...param] = del.trim().split(';');
      if (!navn) continue;
      const qp = param.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const verdi = qp ? Number(qp.slice(2)) : 1;
      q.set(navn.trim(), Number.isFinite(verdi) ? verdi : 0);
    }
    const godtar = (navn) => (q.has(navn) ? q.get(navn) > 0 : q.has('*') && q.get('*') > 0);
    if (q.has('br') && q.get('br') > 0) return 'br';
    if (godtar('gzip')) return 'gzip';
    return null;
  }

  return { planlegg, lagKortBuffer, rovingMaal, KOMPRIMER_FRA, velgKoding };
});
