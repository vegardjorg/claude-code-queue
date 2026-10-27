// =============================================================
// koDiagnose.js: rask diagnose når arbeidskøen går på lav parallellitet.
//
// Bakgrunn: en kø kan gå på få av de mulige sporene uten at noe varsler. Typiske feil som stenger fokus er en
// avhengighet til en kansellert oppgave (slått sammen i en annen), en avhengighet til en id som ikke finnes, en
// «dratt med»-avhengighet i et pauset prosjekt, og løse ventinger (spørsmål eieren ikke ser, eller som er besvart
// men likevel blokkerer).
//
// Vakten: er antallet agenter som kjører (koLogikk.tellerSomAgent: kjorer og review uten plukket_av) under terskelen
// (standard 70 %) av grenser.maksSamtidig, skriver `ko.mjs fyll`, `motta`, `orkestrator puls` og `tilstand` (feltet
// `parallell`) et kort avsnitt. `ko.mjs diagnose` viser alltid hele diagnosen.
//
// Diagnosen fikser aldri selv. Den INFORMERER, og hvert funn klassifiseres:
//   «enkel»    mekanisk og entydig (kansellert avhengighet med kjent erstatter, ukjent id med én kandidat, dratt med i
//              pause, besvart spørsmål som likevel blokkerer): en ferdig kommando som orkestratoren kjører.
//   «kompleks» flere mulige erstattere, ukjent id uten entydig kandidat, flaskehals, eierventing: valg med anbefaling
//              som legges fram for eieren.
//
// Ren logikk: leser køen, skriver aldri (testet i scripts/orkestrator/lib/__tests__/koDiagnose.test.ts). Logikken for
// hva som kan startes, prioriteten og grensene ligger i koLogikk.js og brukes bare lesende her.
// =============================================================

const L = require('./koLogikk.js');

/** Standardterskelen: lav parallellitet når aktive < terskel × maksSamtidig (`ko.mjs grense parallellTerskel`). */
const STANDARD_TERSKEL = 0.7;

/** Kommandoen funnene foreslår (kjøres fra repo-rota, også fra et worktree). */
const KO = 'node scripts/orkestrator/ko.mjs';

/** Merknaden samle pakk (og orkestratoren) skriver på en kansellert oppgave: «<tid> slått sammen i <ny-id>». */
const ERSTATTER_MONSTER = /slått sammen i\s+([A-Za-z0-9ÆØÅæøå][A-Za-z0-9ÆØÅæøå._-]*)/;

/** Høyst så mange flaskehalser i diagnosen. */
const FLASKEHALS_MAKS = 3;

/** Rekkefølgen funnene vises i (innen samme klasse): de som blokkerer mest, først. */
const TYPE_REKKEFOLGE = [
  'avhenger-kansellert',
  'avhenger-ukjent',
  'dratt-med-pauset',
  'lose-venting',
  'venter-paa-avklart',
  'kapasitet',
  'flaskehals',
];

/**
 * Grensene som kan holde igjen en ellers klar oppgave, i samme rekkefølge som velgNeste prøver dem.
 * `holdere` = sporene som har plassene grensen teller.
 */
const KAPASITET = [
  {
    navn: 'maksDPluss',
    treffer: (o) => o.klasse === 'D+',
    holdere: (alle) => alle.filter((o) => L.tellerSomAgent(o) && o.klasse === 'D+'),
  },
  {
    navn: 'maksDb',
    treffer: (o) => L.harMigr(o),
    holdere: (alle) =>
      alle.filter((o) => L.AKTIVE.has(o.status) && !L.erEksternRad(o) && L.harMigr(o)),
  },
];

/** Rydding: funn som ikke blokkerer noe (besvart spørsmål som fortsatt står i venter_paa). */
const erRydding = (f) => f?.type === 'venter-paa-avklart';

/** Terskelen fra køfila, eller standard. Bare tall i [0, 1] gjelder. */
function terskelFor(ko) {
  const v = Number(ko?.grenser?.parallellTerskel);
  return ko?.grenser?.parallellTerskel != null && Number.isFinite(v) && v >= 0 && v <= 1
    ? v
    : STANDARD_TERSKEL;
}

/**
 * Tolker en ny terskel (`ko.mjs grense parallellTerskel <0-1>`): et tall mellom 0 og 1 (komma eller punktum), eller en
 * prosent som «70 %». 0 slår vakten av.
 * @returns {{ verdi: number } | { feil: string }}
 */
function tolkTerskel(raa) {
  const s = String(raa ?? '')
    .trim()
    .replace(',', '.');
  const prosent = /^(\d+(?:\.\d+)?)\s*%$/.exec(s);
  const v = prosent ? Number(prosent[1]) / 100 : s ? Number(s) : NaN;
  if (!Number.isFinite(v) || v < 0 || v > 1)
    return {
      feil: 'parallellTerskel må være et tall fra 0 til 1 (f.eks. 0.7) eller en prosent (70 %)',
    };
  return { verdi: Math.round(v * 100) / 100 };
}

/** Kommandoen som setter `avhenger` til en ny liste. */
const endreAvhenger = (id, liste) =>
  `${KO} endre ${id} --json '${JSON.stringify({ avhenger: liste })}'`;

/** avhenger-lista der `fra` er byttet med `til` (uten duplikater; `til` = null fjerner den). */
function byttAvhengighet(liste, fra, til) {
  const ut = [];
  for (const d of liste ?? []) {
    const ny = d === fra ? til : d;
    if (ny != null && !ut.includes(ny)) ut.push(ny);
  }
  return ut;
}

/**
 * Erstatteren til en kansellert oppgave: fra merknaden «slått sammen i X», ellers fra `sammenslatt_fra` på en annen
 * oppgave. Følger kjeden (X kan selv være slått sammen videre), høyst 10 ledd. Returnerer alle kandidatene; én =
 * entydig.
 */
function erstattere(dep, perId, oppgaver) {
  const funnet = new Set();
  const direkte = (id) => {
    const o = perId.get(id);
    const ut = new Set();
    for (const m of o?.merknader ?? []) {
      const t = ERSTATTER_MONSTER.exec(String(m));
      if (t && t[1] !== id) ut.add(t[1]);
    }
    for (const x of oppgaver)
      if (Array.isArray(x.sammenslatt_fra) && x.sammenslatt_fra.includes(id) && x.id !== id)
        ut.add(x.id);
    return [...ut];
  };
  for (const start of direkte(dep)) {
    let id = start;
    const sett = new Set([dep]);
    for (let i = 0; i < 10; i++) {
      const o = perId.get(id);
      if (!o || o.status !== 'kansellert' || sett.has(id)) break;
      sett.add(id);
      const neste = direkte(id);
      if (neste.length !== 1) break;
      id = neste[0];
    }
    funnet.add(id);
  }
  return [...funnet];
}

/** Grunnstammen til en id: uten revisjonsendelse «-r<n>» (A-1-r2 → A-1). */
const grunnstamme = (id) => String(id).replace(/-r\d+$/i, '');
/** Revisjonsnummeret (A-1-r3 → 3), eller null uten revisjonsendelse. */
const revisjon = (id) => {
  const t = /-r(\d+)$/i.exec(String(id));
  return t ? Number(t[1]) : null;
};

/**
 * Kandidater for en ukjent avhengighet: oppgaver med samme grunnstamme (A-1-r2 → A-1, A-1-r3), som ikke er
 * kansellert, og ferdige foretrekkes. Er den ukjente id-en en revisjon og det finnes andre revisjoner, er den høyeste
 * (helst ferdige) revisjonen den ene kandidaten: en senere revisjon erstatter de tidligere. Ellers alle treffene.
 */
function naereIder(dep, oppgaver, egenId) {
  const stamme = grunnstamme(dep);
  if (!stamme) return [];
  const treff = oppgaver.filter(
    (o) =>
      o.id !== egenId &&
      o.id !== dep &&
      o.status !== 'kansellert' &&
      !L.erEksternRad(o) &&
      grunnstamme(o.id) === stamme,
  );
  const ferdigeFoerst = (liste) => {
    const ferdige = liste.filter((o) => o.status === 'ferdig');
    return ferdige.length ? ferdige : liste;
  };
  if (revisjon(dep) != null) {
    const rev = ferdigeFoerst(treff.filter((o) => revisjon(o.id) != null));
    if (rev.length) {
      const hoyest = Math.max(...rev.map((o) => revisjon(o.id)));
      return rev.filter((o) => revisjon(o.id) === hoyest).map((o) => o.id);
    }
  }
  return ferdigeFoerst(treff)
    .map((o) => o.id)
    .sort((a, b) => a.localeCompare(b));
}

/** Hvorfor kan ikke en oppgave starte selv (flaskehals)? Kort tekst. */
function egenGrunn(o, ko, k) {
  if (o.status === 'kjorer') return 'kjører (spor eller retterunde)';
  if (o.status === 'review') return 'i review (venter på review og fletting)';
  if (o.status === 'plukket') return `plukket av ${o.plukket_av ?? '?'}`;
  if (o.status === 'forslag') return 'forslag (ikke godkjent)';
  const h = L.hindringerMedPause(o, ko, k);
  return h.length ? h.slice(0, 2).join('; ') : 'klar, men fikk ikke plass (grenser eller konflikt)';
}

/** Anbefalingen for en flaskehals, etter hva den venter på. */
function flaskehalsAnbefaling(o, ko) {
  if (o.status === 'review') return `prioriter review og fletting av ${o.id}`;
  if (o.status === 'kjorer')
    return `la ${o.id} gå ferdig; ingen handling med mindre sporet står fast`;
  if (o.status === 'plukket')
    return `spør ${o.plukket_av ?? 'den som plukket'} om fremdrift, eller ko.mjs slipp ${o.id}`;
  if (o.status === 'forslag') return `eieren godkjenner eller avviser: ${KO} godkjenn ${o.id}`;
  const sp = L.aapneSporsmal(o, ko.avklart);
  if (sp.length) return `eierens svar på ${sp.join(', ')} låser den opp`;
  if (L.prosjektPauset(o, ko.prosjekter ?? {}))
    return `eieren avgjør om prosjektet ${L.prosjektFor(o, ko.prosjekter ?? {})} skal av pause`;
  return 'se hindringene (ko.mjs vis --full); ingen mekanisk retting';
}

/**
 * Diagnosen for lav parallellitet. Ren: leser køen, skriver aldri.
 * @param {object} ko køen
 * @param {{ naa?: number }} [valg] naa = tidspunktet (ms) fokus og parkering vurderes mot
 * @returns {{ aktive: number, maks: number, terskel: number, andel: number, lav: boolean, fokus: boolean,
 *   funn: Array<{ type: string, id: string, bak: number, klasse: 'enkel'|'kompleks', tekst: string,
 *   kommando?: string, valg?: Array<{ tekst: string, kommando?: string }>, anbefaling?: string, dep?: string,
 *   sp?: string }> }}
 */
function parallellDiagnose(ko, { naa = Date.now() } = {}) {
  const oppgaver = (ko?.oppgaver ?? []).filter((o) => !L.erEksternRad(o));
  const register = ko?.prosjekter ?? {};
  const bruk = L.plassBruk(ko ?? {});
  const maks = Number(bruk.grenser.maksSamtidig) || 0;
  const aktive = bruk.agenter;
  const terskel = terskelFor(ko);
  const andel = maks > 0 ? aktive / maks : 1;
  const lav = maks > 0 && aktive < terskel * maks;

  const alle = ko?.oppgaver ?? [];
  const perId = new Map(alle.map((o) => [o.id, o]));
  const barn = L.barnKart(alle);
  const k = L.rangeringKontekst(ko, naa);
  const plass = new Map();
  const plassFor = (o) => {
    if (!plass.has(o.id)) plass.set(o.id, L.fokusPlass(o, k));
    return plass.get(o.id);
  };
  // «I fokus»: ventende oppgaver med eget trinn eller dratt med (uten gjeldende fokus: alle ventende).
  const iFokus = (o) => !k.gjelder || plassFor(o).steg != null;
  const fokusSett = new Set(
    oppgaver.filter((o) => o.status === 'venter' && !L.erSamles(o) && iFokus(o)).map((o) => o.id),
  );
  // Hvor mange fokusoppgaver står bak (oppgaven selv medregnet når den er i fokus)?
  const bakMemo = new Map();
  const bak = (id, { medSelv = true } = {}) => {
    const nokkel = `${id}|${medSelv}`;
    if (!bakMemo.has(nokkel)) {
      const ider = L.etterfolgere(id, alle, barn).filter((x) => fokusSett.has(x));
      bakMemo.set(nokkel, ider.length + (medSelv && fokusSett.has(id) ? 1 : 0));
    }
    return bakMemo.get(nokkel);
  };

  const funn = [];
  const aapne = oppgaver.filter((o) => o.status === 'venter' || o.status === 'forslag');

  // 1 og 2: avhengighet til kansellert eller ukjent oppgave.
  for (const o of aapne) {
    for (const dep of o.avhenger ?? []) {
      const d = perId.get(dep);
      if (d && d.status === 'kansellert') {
        const kand = erstattere(dep, perId, alle).filter((x) => x !== o.id);
        const grunn = `${dep} er kansellert`;
        if (kand.length === 1) {
          funn.push({
            type: 'avhenger-kansellert',
            id: o.id,
            dep,
            bak: bak(o.id),
            klasse: 'enkel',
            tekst: `${grunn}, slått sammen i ${kand[0]}`,
            kommando: endreAvhenger(o.id, byttAvhengighet(o.avhenger, dep, kand[0])),
          });
        } else {
          funn.push({
            type: 'avhenger-kansellert',
            id: o.id,
            dep,
            bak: bak(o.id),
            klasse: 'kompleks',
            tekst: kand.length
              ? `${grunn}; flere mulige erstattere: ${kand.join(', ')}`
              : `${grunn} uten kjent erstatter`,
            valg: [
              ...kand.map((x) => ({
                tekst: `pek om til ${x}`,
                kommando: endreAvhenger(o.id, byttAvhengighet(o.avhenger, dep, x)),
              })),
              {
                tekst: `fjern avhengigheten (arbeidet i ${dep} trengs ikke lenger)`,
                kommando: endreAvhenger(o.id, byttAvhengighet(o.avhenger, dep, null)),
              },
            ],
            anbefaling: kand.length
              ? `velg erstatteren som faktisk gjorde arbeidet i ${dep} (se merknadene)`
              : `fjern avhengigheten hvis ${dep} ble droppet med vilje; ellers legg inn erstatteren`,
          });
        }
      } else if (!d) {
        const kand = naereIder(dep, alle, o.id);
        if (kand.length === 1) {
          funn.push({
            type: 'avhenger-ukjent',
            id: o.id,
            dep,
            bak: bak(o.id),
            klasse: 'enkel',
            tekst: `${dep} finnes ikke; nær id ${kand[0]} (${perId.get(kand[0])?.status})`,
            kommando: endreAvhenger(o.id, byttAvhengighet(o.avhenger, dep, kand[0])),
          });
        } else {
          funn.push({
            type: 'avhenger-ukjent',
            id: o.id,
            dep,
            bak: bak(o.id),
            klasse: 'kompleks',
            tekst: kand.length
              ? `${dep} finnes ikke; flere nære id-er: ${kand.join(', ')}`
              : `${dep} finnes ikke, og ingen nær id`,
            valg: [
              ...kand.map((x) => ({
                tekst: `pek om til ${x}`,
                kommando: endreAvhenger(o.id, byttAvhengighet(o.avhenger, dep, x)),
              })),
              {
                tekst: 'fjern avhengigheten',
                kommando: endreAvhenger(o.id, byttAvhengighet(o.avhenger, dep, null)),
              },
            ],
            anbefaling: kand.length
              ? 'velg den siste leverte revisjonen hvis den dekker det oppgaven trenger'
              : 'finn ut hva id-en skulle peke på (kilde, oppdrag); fjern den hvis arbeidet er gjort',
          });
        }
      }
    }
  }

  // 3: dratt med av en fokusoppgave, men prosjektet er pauset (pausen går foran, så den startes aldri).
  for (const [id, d] of k.dratt) {
    const o = perId.get(id);
    if (!o || o.status !== 'venter' || !L.prosjektPauset(o, register)) continue;
    const drar = perId.get(d.av);
    const pid = drar ? L.prosjektFor(drar, register) : null;
    if (!pid || L.prosjektPauset(drar, register)) continue;
    funn.push({
      type: 'dratt-med-pauset',
      id,
      bak: bak(id),
      klasse: 'enkel',
      tekst:
        `dratt med av ${d.av} (${pid}), men prosjektet ${L.prosjektFor(o, register)} er pauset; ` +
        `flytt den til ${pid}`,
      kommando: `${KO} endre ${id} --json '${JSON.stringify({ prosjekt: pid })}'`,
    });
  }

  // 4: løse ventinger. Et besvart spørsmål som likevel blokkerer, er mekanisk; resten trenger tekst.
  for (const x of L.loseVentinger(ko ?? {})) {
    if (L.erEksternRad(perId.get(x.id))) continue;
    if (x.grunn === 'avklart-blokkerer') {
      funn.push({
        type: 'lose-venting',
        id: x.id,
        sp: x.sp,
        bak: bak(x.id),
        klasse: 'enkel',
        tekst: `${x.sp} er besvart, men står ikke i avklart (blokkerer likevel)`,
        kommando: `${KO} avklar ${x.sp}`,
      });
    } else {
      funn.push({
        type: 'lose-venting',
        id: x.id,
        sp: x.sp,
        bak: bak(x.id),
        klasse: 'kompleks',
        tekst:
          x.grunn === 'fritekst'
            ? `venter på fritekst «${String(x.sp).slice(0, 50)}», ikke et registrert spørsmål (eieren ser det ikke)`
            : `venter på ${x.sp}, som ikke er registrert med tekst (eieren ser det ikke)`,
        valg: [
          {
            tekst: 'registrer spørsmålet med tekst og type, og la oppgaven vente på id-en',
            kommando: `${KO} sporsmal <id> --tekst "…" --type sporsmal`,
          },
          { tekst: 'fjern ventingen hvis den ikke lenger gjelder (endre venter_paa)' },
        ],
        anbefaling:
          'registrer spørsmålet (teksten fra oppdraget), så eieren ser det i «Venter på deg»',
      });
    }
  }

  // 5: venter_paa står fortsatt med et avklart spørsmål (blokkerer ikke, men forvirrer «Venter på deg» og tellingene).
  const avklart = new Set(ko?.avklart ?? []);
  for (const o of aapne) {
    const vp = Array.isArray(o.venter_paa) ? o.venter_paa : [];
    const besvart = vp.filter((sp) => avklart.has(sp));
    if (!besvart.length) continue;
    funn.push({
      type: 'venter-paa-avklart',
      id: o.id,
      sp: besvart.join(', '),
      bak: bak(o.id),
      klasse: 'enkel',
      tekst: `venter_paa har besvart ${besvart.join(', ')} (blokkerer ikke; rydding)`,
      kommando: `${KO} endre ${o.id} --json '${JSON.stringify({ venter_paa: vp.filter((sp) => !avklart.has(sp)) })}'`,
    });
  }

  const kanStarte = (o) =>
    o.status === 'venter' &&
    !L.erSamles(o) &&
    L.hindringer(o, alle, ko?.avklart).length === 0 &&
    !plassFor(o).ut;

  // 6: klare fokusoppgaver som en kapasitetsgrense holder igjen. Uten dette ville diagnosen vist tomme hindringer og
  // bare flaskehalser (f.eks. klare D+ som står fordi maksDPluss er brukt opp). Å heve en grense er eierens valg, så
  // funnet er kompleks med grense-kommandoen som anbefaling.
  if (bruk.ledige > 0) {
    const tall = { maksDPluss: bruk.dPluss, maksDb: bruk.db };
    for (const g of KAPASITET) {
      const grense = Number(bruk.grenser[g.navn]);
      if (!Number.isFinite(grense) || tall[g.navn] < grense) continue;
      const holdtIgjen = oppgaver
        .filter((o) => fokusSett.has(o.id) && kanStarte(o) && g.treffer(o))
        .map((o) => o.id)
        .sort((a, b) => a.localeCompare(b));
      if (!holdtIgjen.length) continue;
      const holdere = g
        .holdere(alle)
        .map((o) => o.id)
        .sort((a, b) => a.localeCompare(b));
      funn.push({
        type: 'kapasitet',
        id: g.navn,
        bak: holdtIgjen.length,
        klasse: 'kompleks',
        tekst:
          `grensen ${g.navn} (${grense}) er nådd av ${holdere.join(', ')}; ` +
          `klare i fokus som venter på plass: ${holdtIgjen.join(', ')}`,
        anbefaling: `la plassene bli ledige, eller hev grensen: ${KO} grense ${g.navn} ${grense + 1}`,
      });
    }
  }

  // 7: flaskehalser: ikke-startbare oppgaver i fokus som flest fokusoppgaver venter på (transitivt). Bare informasjon.
  const flask = oppgaver
    .filter(
      (o) =>
        L.STATUSER.has(o.status) &&
        !['ferdig', 'kansellert'].includes(o.status) &&
        !L.erSamles(o) &&
        iFokus(o) &&
        !kanStarte(o),
    )
    .map((o) => ({ o, n: bak(o.id, { medSelv: false }) }))
    .filter((x) => x.n > 0)
    .sort((x, y) => y.n - x.n || x.o.id.localeCompare(y.o.id))
    .slice(0, FLASKEHALS_MAKS);
  for (const { o, n } of flask) {
    funn.push({
      type: 'flaskehals',
      id: o.id,
      bak: n,
      klasse: 'kompleks',
      tekst: `${n} fokusoppgave(r) venter på den; selv: ${egenGrunn(o, ko, k)}`,
      anbefaling: flaskehalsAnbefaling(o, ko),
    });
  }

  // Enkle først (de kan rettes med én gang), så typen, så flest bak; flaskehalsene og ryddingen sist.
  const typeNr = (t) => TYPE_REKKEFOLGE.indexOf(t);
  const sist = (f) => (erRydding(f) ? 2 : f.type === 'flaskehals' ? 1 : 0);
  funn.sort(
    (x, y) =>
      sist(x) - sist(y) ||
      (x.klasse === 'enkel' ? 0 : 1) - (y.klasse === 'enkel' ? 0 : 1) ||
      typeNr(x.type) - typeNr(y.type) ||
      y.bak - x.bak ||
      x.id.localeCompare(y.id),
  );
  return { aktive, maks, terskel, andel, lav, fokus: k.gjelder, funn };
}

const pst = (x) => `${Math.round(x * 100)} %`;

/** Overskriften: «LAV PARALLELLITET: 2 av 6 spor (33 %, terskel 70 %). Rask diagnose:». */
function overskrift(d) {
  return (
    `${d.lav ? 'LAV PARALLELLITET' : 'Parallellitet'}: ${d.aktive} av ${d.maks} spor ` +
    `(${pst(d.andel)}, terskel ${pst(d.terskel)}).${d.lav ? ' Rask diagnose:' : ''}`
  );
}

/** Én linje for et funn (kort avsnitt). */
function funnLinje(f) {
  const hvor = `${f.id}${f.bak ? ` (${f.bak} i fokus bak)` : ''}`;
  const hva = `  [${f.klasse}] ${f.type} ${hvor}: ${f.tekst}`;
  if (f.klasse === 'enkel') return `${hva}. Kjør: ${f.kommando}`;
  return `${hva}. Eieren: ${f.anbefaling}`;
}

/**
 * Det korte avsnittet (fyll, motta, orkestrator puls): høyst `maks` linjer, tomt når parallelliteten ikke er lav.
 * Rydding (venter-paa-avklart) er ikke med: den blokkerer ikke, og køen har mange slike (de står bare i ko.mjs diagnose).
 */
function diagnoseLinjer(d, { maks = 12 } = {}) {
  if (!d?.lav) return [];
  const viktige = d.funn.filter((f) => !erRydding(f));
  const ut = [overskrift(d)];
  if (!viktige.length) {
    ut.push(
      '  Ingen mekaniske feil i avhengighetene eller ventingene. Se ko.mjs vis (grenser, konflikter, fokus som venter).',
    );
    return ut;
  }
  const hale = [
    '  Enkle: orkestratoren kjører kommandoen. Komplekse: legg valget med anbefaling fram for eieren (ko.mjs diagnose).',
  ];
  const plass = Math.max(1, maks - 1 - hale.length);
  const vis = viktige.slice(0, viktige.length > plass ? plass - 1 : plass);
  for (const f of vis) ut.push(funnLinje(f));
  if (viktige.length > vis.length)
    ut.push(`  +${viktige.length - vis.length} funn til (ko.mjs diagnose)`);
  return [...ut, ...hale];
}

/** Hele diagnosen (ko.mjs diagnose): alle funn, med valg og anbefaling for de komplekse. */
function diagnoseFull(d) {
  const ut = [overskrift(d).replace(' Rask diagnose:', '')];
  ut.push(
    d.lav
      ? 'Under terskelen: avsnittet vises i fyll, motta, orkestrator puls og tilstand (feltet parallell).'
      : 'Over terskelen: avsnittet vises ikke i fyll, motta og puls.',
  );
  if (!d.funn.length) {
    ut.push('Ingen funn.');
    return ut;
  }
  const enkle = d.funn.filter((f) => f.klasse === 'enkel' && !erRydding(f));
  const komplekse = d.funn.filter((f) => f.klasse === 'kompleks');
  const rydding = d.funn.filter(erRydding);
  if (enkle.length) {
    ut.push('', `ENKLE (${enkle.length}): mekaniske og entydige; orkestratoren kjører kommandoen.`);
    for (const f of enkle) {
      ut.push(`  ${f.type} ${f.id}${f.bak ? ` (${f.bak} i fokus bak)` : ''}: ${f.tekst}`);
      ut.push(`    ${f.kommando}`);
    }
  }
  if (komplekse.length) {
    ut.push('', `KOMPLEKSE (${komplekse.length}): valg med anbefaling til eieren.`);
    for (const f of komplekse) {
      ut.push(`  ${f.type} ${f.id}${f.bak ? ` (${f.bak} i fokus bak)` : ''}: ${f.tekst}`);
      for (const v of f.valg ?? [])
        ut.push(`    valg: ${v.tekst}${v.kommando ? `: ${v.kommando}` : ''}`);
      ut.push(`    anbefaling: ${f.anbefaling}`);
    }
  }
  if (rydding.length) {
    ut.push(
      '',
      `RYDDING (${rydding.length}): besvarte spørsmål som fortsatt står i venter_paa. Blokkerer ikke; enkel, men ` +
        'valgfri (venter_paa viser også hvilket svar som låste opp oppgaven).',
    );
    for (const f of rydding) ut.push(`  ${f.id}: ${f.sp}    ${f.kommando}`);
  }
  return ut;
}

module.exports = {
  STANDARD_TERSKEL,
  ERSTATTER_MONSTER,
  terskelFor,
  tolkTerskel,
  erstattere,
  grunnstamme,
  naereIder,
  parallellDiagnose,
  diagnoseLinjer,
  diagnoseFull,
};
