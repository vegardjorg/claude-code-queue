/**
 * @vitest-environment jsdom
 */
// =============================================================
// koTavleYtelse.test.ts: køtavla tegner ikke hele tavla på nytt ved søk, merking og ny versjon.
//
// To deler:
//   1. De rene funksjonene i scripts/orkestrator/ko-tavle/ytelse.js: diffen (gammel og ny liste gir operasjonene
//      gjenbruk, bygg og fjern), kortbufferen som bruker den, tastaturnavigasjonen mellom kort og kolonner, og
//      valget av komprimering for svar fra serveren.
//   2. Hele tavla i jsdom med en syntetisk kø på 1 150 oppgaver (laget her, ingen ekte data i repoet): søket skjuler
//      kort uten å bygge dem på nytt, en merking og en ny versjon gjenbruker nodene til kortene som ikke er endret,
//      Blokkert er lukket og ikke bygget før den åpnes, og kortet har én knapp (tittelen) i stedet for tabindex og
//      aria-label på hele kortet. Tidene skrives ut med performance.now() (tallene skrives til konsollen).
//
// Måle en annen versjon av tavla (f.eks. den før endringen): sett KO_TAVLE_JS til stien til den tavle.js-fila. Da
// skrives tidene ut, og atferdstestene sier hva den versjonen mangler.
// =============================================================
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Y = require('../../ko-tavle/ytelse.js') as {
  planlegg: (
    gamle: Map<string, string>,
    nye: Iterable<[string, string]>,
  ) => { gjenbruk: string[]; bygg: string[]; fjern: string[] };
  lagKortBuffer: () => {
    start: () => void;
    node: <N>(nokkel: string, signatur: string, bygg: () => N) => N;
    slutt: () => { gjenbrukt: number; bygget: number; fjernet: number };
    storrelse: () => number;
  };
  rovingMaal: (
    antall: number[],
    o: number,
    i: number,
    tast: string,
  ) => { o: number; i: number } | null;
  velgKoding: (acceptEncoding: string | undefined, bytes: number) => 'br' | 'gzip' | null;
  KOMPRIMER_FRA: number;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../koTavle.js') as { tavle: (ko: unknown, valg?: unknown) => any };

const KLIENT = join(__dirname, '..', '..', 'ko-tavle');

// Tidsgrensen for hver test og hook i fila. Alene går fila på noen sekunder, men i en full testkjøring med
// parallelle spor kan beforeAll bruke over standardgrensen på 5 000 ms. Tidene her logges bare, de asserteres ikke, så en romsligere grense svekker
// ingen ytelseskrav: atferdstestene (gjenbruk av noder, ingen ombygging) er det som vokter ytelsen.
const TIDSGRENSE_MS = 60_000;
vi.setConfig({ testTimeout: TIDSGRENSE_MS });

// ---------------------------------------------------------------------------------------------------------------
// 1. De rene funksjonene
// ---------------------------------------------------------------------------------------------------------------
describe('planlegg (diffen)', () => {
  it('gjenbruker uendrede, bygger endrede og nye, og fjerner de som er borte', () => {
    const gamle = new Map([
      ['a', '1'],
      ['b', '1'],
      ['c', '1'],
    ]);
    const ops = Y.planlegg(gamle, [
      ['a', '1'],
      ['b', '2'],
      ['d', '1'],
    ]);
    expect(ops).toEqual({ gjenbruk: ['a'], bygg: ['b', 'd'], fjern: ['c'] });
  });

  it('bygger en nøkkel som står to ganger i den nye lista på nytt (én node kan bare stå ett sted)', () => {
    const ops = Y.planlegg(new Map([['a', '1']]), [
      ['a', '1'],
      ['a', '1'],
    ]);
    expect(ops).toEqual({ gjenbruk: ['a'], bygg: ['a'], fjern: [] });
  });

  it('tom gammel liste bygger alt, tom ny liste fjerner alt', () => {
    expect(Y.planlegg(new Map(), [['x', 's']])).toEqual({ gjenbruk: [], bygg: ['x'], fjern: [] });
    expect(Y.planlegg(new Map([['x', 's']]), [])).toEqual({ gjenbruk: [], bygg: [], fjern: ['x'] });
  });
});

describe('lagKortBuffer', () => {
  it('gir samme node for samme nøkkel og signatur, ny node når signaturen endres, og rydder bort ubrukte', () => {
    const b = Y.lagKortBuffer();
    let n = 0;
    const lag = () => ({ nr: ++n });
    b.start();
    const a1 = b.node('a', 's1', lag);
    const c1 = b.node('c', 's1', lag);
    expect(b.slutt()).toEqual({ gjenbrukt: 0, bygget: 2, fjernet: 0 });

    b.start();
    expect(b.node('a', 's1', lag)).toBe(a1);
    const a2 = b.node('a', 's1', lag); // samme nøkkel to ganger i én runde: ny node
    expect(a2).not.toBe(a1);
    expect(b.slutt()).toEqual({ gjenbrukt: 1, bygget: 1, fjernet: 1 }); // c er borte
    expect(b.storrelse()).toBe(1);

    b.start();
    expect(b.node('a', 's2', lag)).not.toBe(a1);
    expect(b.node('c', 's1', lag)).not.toBe(c1);
    b.slutt();
  });
});

describe('rovingMaal (tastaturet mellom kort og kolonner)', () => {
  const antall = [3, 0, 5, 1];
  it('pil opp og ned går innen kolonnen og stopper i endene', () => {
    expect(Y.rovingMaal(antall, 0, 0, 'ArrowDown')).toEqual({ o: 0, i: 1 });
    expect(Y.rovingMaal(antall, 0, 2, 'ArrowDown')).toBeNull();
    expect(Y.rovingMaal(antall, 0, 0, 'ArrowUp')).toBeNull();
    expect(Y.rovingMaal(antall, 2, 4, 'ArrowUp')).toEqual({ o: 2, i: 3 });
  });
  it('pil venstre og høyre hopper over tomme kolonner og holder plassen (avgrenset til lengden)', () => {
    expect(Y.rovingMaal(antall, 0, 2, 'ArrowRight')).toEqual({ o: 2, i: 2 });
    expect(Y.rovingMaal(antall, 2, 4, 'ArrowRight')).toEqual({ o: 3, i: 0 });
    expect(Y.rovingMaal(antall, 3, 0, 'ArrowRight')).toBeNull();
    expect(Y.rovingMaal(antall, 2, 4, 'ArrowLeft')).toEqual({ o: 0, i: 2 });
    expect(Y.rovingMaal(antall, 0, 1, 'ArrowLeft')).toBeNull();
  });
  it('Home og End går til første og siste kort i kolonnen; andre taster gir null', () => {
    expect(Y.rovingMaal(antall, 2, 2, 'Home')).toEqual({ o: 2, i: 0 });
    expect(Y.rovingMaal(antall, 2, 2, 'End')).toEqual({ o: 2, i: 4 });
    expect(Y.rovingMaal(antall, 2, 2, 'a')).toBeNull();
    expect(Y.rovingMaal(antall, 1, 0, 'ArrowDown')).toBeNull(); // tom kolonne
  });
});

describe('velgKoding (komprimering i send)', () => {
  const stor = Y.KOMPRIMER_FRA + 1;
  it('komprimerer bare svar over grensen, og bare når klienten sier at den støtter det', () => {
    expect(Y.KOMPRIMER_FRA).toBe(50 * 1024);
    expect(Y.velgKoding('gzip, deflate, br', 1000)).toBeNull();
    expect(Y.velgKoding(undefined, stor)).toBeNull();
    expect(Y.velgKoding('', stor)).toBeNull();
    expect(Y.velgKoding('identity', stor)).toBeNull();
  });
  it('foretrekker brotli, tar gzip ellers, og respekterer q=0', () => {
    expect(Y.velgKoding('gzip, deflate, br', stor)).toBe('br');
    expect(Y.velgKoding('gzip, deflate', stor)).toBe('gzip');
    expect(Y.velgKoding('GZIP', stor)).toBe('gzip');
    expect(Y.velgKoding('br;q=0, gzip;q=0.5', stor)).toBe('gzip');
    expect(Y.velgKoding('gzip;q=0', stor)).toBeNull();
    expect(Y.velgKoding('*', stor)).toBe('gzip');
    expect(Y.velgKoding('*;q=0', stor)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Hele tavla i jsdom med en syntetisk kø
// ---------------------------------------------------------------------------------------------------------------

/** En syntetisk ko.json med 1 150 oppgaver i 60 prosjekter (ingen ekte data). */
function lagKo() {
  const naa = Date.now();
  const iso = (dagerSiden: number) => new Date(naa - dagerSiden * 86_400_000).toISOString();
  const prosjekter: Record<string, unknown> = {};
  for (let p = 0; p < 60; p++)
    prosjekter[`p${p}`] = { tittel: `Prosjekt ${p}`, prefikser: [`P${p}-`], omrade: 'eksempel' };
  const oppgaver: Record<string, unknown>[] = [];
  const felles = (id: string, i: number) => ({
    id,
    tittel: `Oppgave ${id} om tema ${i % 37}`,
    domene: `d${i % 9}`,
    klasse: ['K', 'D', 'D+', 'U'][i % 4],
    nytte: (i % 10) + 1,
    innhold_min: 20 + (i % 90),
    migr_tiere: i % 3,
    avhenger: [] as string[],
    venter_paa: [],
    eier_filer: [`fil/${id}.ts`],
    eier_db: [],
    delt_patch: [],
    oppdrag: `scripts/.ko/oppdrag/${id}.md`,
    lagt_til_av: 'test',
    lagt_til: iso(30 - (i % 30)),
  });
  let n = 0;
  const id = () => `P${n % 60}-${n}`;
  // 460 i kø: annenhver avhenger av en annen som venter (blokkert).
  const ventende: string[] = [];
  for (let i = 0; i < 460; i++, n++) {
    const o = { ...felles(id(), n), status: 'venter' };
    if (i % 2 && ventende.length) o.avhenger = [ventende[ventende.length - 1]];
    ventende.push(o.id);
    oppgaver.push(o);
  }
  for (let i = 0; i < 90; i++, n++) oppgaver.push({ ...felles(id(), n), status: 'forslag' });
  for (let i = 0; i < 5; i++, n++)
    oppgaver.push({ ...felles(id(), n), status: 'kjorer', startet: iso(0.1), agent: 'a' });
  for (let i = 0; i < 595; i++, n++)
    oppgaver.push({
      ...felles(id(), n),
      status: 'ferdig',
      startet: iso((i % 40) + 1),
      ferdig: iso(i % 40),
    });
  return {
    opprettet: iso(60),
    grenser: { maksSamtidig: 6, maksDPluss: 3, maksPerDomene: 7, maksDb: 6 },
    oppgaver,
    prosjekter,
    omrader: { eksempel: { tittel: 'Eksempel', beskrivelse: 'Test' } },
    sporsmal: [],
    avklaringer: [],
    endringslogg: [],
  };
}

type Tilstand = { versjon: string; data: any };
let tilstand: Tilstand;
const venterSok: (() => void)[] = [];
const tider: Record<string, number> = {};
let main: HTMLElement;

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const kortNode = (kortId: string) =>
  main.querySelector(`.kort[data-id="${kortId}"]`) as HTMLElement | null;

beforeAll(async () => {
  const ko = lagKo();
  tilstand = { versjon: 'v1', data: { ...T.tavle(ko), gitFeil: null, logo: false } };
  const html = readFileSync(join(KLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html
    .replace(/<!doctype[^>]*>/i, '')
    .replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('ko-tavle-nokkel', 'testnokkel');
  localStorage.clear();
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  const ekteTimeout = w.setTimeout.bind(w);
  // Søket venter 150 ms; testen kjører tilbakekallet selv, så tida måles uten ventinga.
  w.setTimeout = (fn: () => void, ms?: number) => {
    if (ms === 150) {
      venterSok.push(fn);
      return 0;
    }
    return ekteTimeout(fn, ms);
  };
  w.fetch = async (sti: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      sti.startsWith('/api/tilstand')
        ? sti.includes(`versjon=${tilstand.versjon}`)
          ? { versjon: tilstand.versjon, uendret: true }
          : tilstand
        : {},
  });
  const filer = [
    join(KLIENT, 'uu.js'),
    join(KLIENT, '..', 'lib', 'koGraf.js'),
    join(KLIENT, 'graf.js'),
    join(KLIENT, 'plan.js'),
  ];
  // ytelse.js er nyere enn de første versjonene; en eldre tavle.js (KO_TAVLE_JS) trenger den ikke.
  if (!process.env.KO_TAVLE_JS) filer.push(join(KLIENT, 'ytelse.js'));
  filer.push(process.env.KO_TAVLE_JS ?? join(KLIENT, 'tavle.js'));
  const t0 = performance.now();
  for (const f of filer) {
    // Indirekte eval: skriptene kjører i det globale skopet (som i nettleseren), der `module` ikke finnes.
    (0, eval)(readFileSync(f, 'utf8'));
  }
  await flush();
  tider.forste = performance.now() - t0;
  main = document.getElementById('tavle') as HTMLElement;
  // Første tegning av 1 150 kort i jsdom tar ofte over standardgrensen på 5 s (særlig under last).
  // Tidene logges bare, de asserteres ikke, så en romsligere frist gjør ikke testen svakere.
}, TIDSGRENSE_MS);

describe('tavla med 1 150 oppgaver', () => {
  it('tegner kolonnene, med Blokkert lukket og ikke bygget før den åpnes', () => {
    expect(main.querySelectorAll('.kolonne').length).toBe(4);
    const blokkert = main.querySelector('details[data-seksjon="blokkert"]') as HTMLDetailsElement;
    expect(blokkert).not.toBeNull();
    expect(blokkert.open).toBe(false);
    expect(blokkert.querySelectorAll('.kort').length).toBe(0);
    blokkert.open = true;
    blokkert.dispatchEvent(new Event('toggle'));
    expect(blokkert.querySelectorAll('.kort').length).toBeGreaterThan(100);
    blokkert.open = false;
    blokkert.dispatchEvent(new Event('toggle'));
  });

  it('kortet har ingen tabindex eller aria-label; tittelen er en knapp med aria-describedby til metadata', () => {
    const li = main.querySelector('.kort') as HTMLElement;
    expect(li.hasAttribute('tabindex')).toBe(false);
    expect(li.hasAttribute('aria-label')).toBe(false);
    const knapp = li.querySelector('button.kort-knapp') as HTMLButtonElement;
    expect(knapp).not.toBeNull();
    for (const ref of (knapp.getAttribute('aria-describedby') ?? '').split(' '))
      expect(document.getElementById(ref)).not.toBeNull();
    // Avkryssingsboksen står utenfor knappen.
    expect(knapp.querySelector('input')).toBeNull();
  });

  it('roving tabindex: ett tab-stopp per kolonne, og piltastene går mellom kort og kolonner', () => {
    for (const kropp of main.querySelectorAll('.kol-kropp')) {
      const stopp = [...kropp.querySelectorAll('.kort-knapp')].filter(
        (b) => (b as HTMLElement).tabIndex === 0,
      );
      expect(stopp.length).toBeLessThanOrEqual(1);
    }
    const kolKo = main.querySelector('.kol-kropp[data-rull="ko"]') as HTMLElement;
    const forste = kolKo.querySelector('.kort-knapp[tabindex="0"]') as HTMLButtonElement;
    forste.focus();
    forste.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const neste = document.activeElement as HTMLElement;
    expect(neste).not.toBe(forste);
    expect(neste.classList.contains('kort-knapp')).toBe(true);
    expect(neste.tabIndex).toBe(0);
    expect(forste.tabIndex).toBe(-1);
    neste.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const hoyre = document.activeElement as HTMLElement;
    expect(hoyre.closest('.kol-kropp')?.getAttribute('data-rull')).toBe('pagar');
  });

  it('søket skjuler kort med hidden uten å bygge dem på nytt', () => {
    const forTreff = kortNode('P4-4') as HTMLElement;
    const forAndre = kortNode('P2-2') as HTMLElement;
    expect(forTreff).not.toBeNull();
    const sok = document.getElementById('sok') as HTMLInputElement;
    sok.value = 'p4-4';
    sok.dispatchEvent(new Event('input'));
    const t0 = performance.now();
    venterSok.splice(0).forEach((f) => f());
    tider.sok = performance.now() - t0;
    expect(kortNode('P4-4')).toBe(forTreff);
    expect(forTreff.hidden).toBe(false);
    expect(kortNode('P2-2')).toBe(forAndre);
    expect(forAndre.hidden).toBe(true);
    sok.value = '';
    sok.dispatchEvent(new Event('input'));
    const t1 = performance.now();
    venterSok.splice(0).forEach((f) => f());
    tider.sokTom = performance.now() - t1;
    expect(forAndre.hidden).toBe(false);
  });

  it('merking oppdaterer kortet der det står, uten ombygging', () => {
    const li = kortNode('P4-4') as HTMLElement;
    const andre = kortNode('P2-2') as HTMLElement;
    const boks = li.querySelector('.merk-boks input') as HTMLInputElement;
    const t0 = performance.now();
    boks.click();
    tider.merk = performance.now() - t0;
    expect(kortNode('P4-4')).toBe(li);
    expect(li.classList.contains('merket')).toBe(true);
    expect(kortNode('P2-2')).toBe(andre);
    boks.click();
    expect(li.classList.contains('merket')).toBe(false);
  });

  it('ny versjon fra serveren bygger bare kortene som er endret', async () => {
    const uendret = kortNode('P2-2') as HTMLElement;
    const endret = kortNode('P4-4') as HTMLElement;
    const data = JSON.parse(JSON.stringify(tilstand.data));
    for (const liste of Object.values(data.kolonner) as any[])
      for (const k of liste) if (k.id === 'P4-4') k.tittel = 'Ny tittel';
    tilstand = { versjon: 'v2', data };
    const t0 = performance.now();
    window.dispatchEvent(new Event('focus'));
    await flush();
    tider.nyVersjon = performance.now() - t0;
    expect(kortNode('P2-2')).toBe(uendret);
    expect(kortNode('P4-4')).not.toBe(endret);
    expect(kortNode('P4-4')?.textContent).toContain('Ny tittel');
  });

  it('måler søk, merking og ny versjon (median av fem) med samme tilstand for begge versjoner', async () => {
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const sok = document.getElementById('sok') as HTMLInputElement;
    const sokEtter = (tekst: string) => {
      sok.value = tekst;
      sok.dispatchEvent(new Event('input'));
      const t0 = performance.now();
      venterSok.splice(0).forEach((f) => f());
      return performance.now() - t0;
    };
    const s: number[] = [];
    const m: number[] = [];
    const v: number[] = [];
    for (let runde = 0; runde < 5; runde++) {
      s.push(sokEtter(`tema ${runde + 3}`));
      s.push(sokEtter(''));
      const boks = kortNode('P2-2')?.querySelector('.merk-boks input') as HTMLInputElement;
      const t0 = performance.now();
      boks.click();
      m.push(performance.now() - t0);
      (kortNode('P2-2')?.querySelector('.merk-boks input') as HTMLInputElement).click();
      const data = JSON.parse(JSON.stringify(tilstand.data));
      for (const liste of Object.values(data.kolonner) as any[])
        for (const k of liste) if (k.id === 'P2-2') k.tittel = `Tittel ${runde}`;
      tilstand = { versjon: `m${runde}`, data };
      const t1 = performance.now();
      window.dispatchEvent(new Event('focus'));
      await flush();
      v.push(performance.now() - t1);
    }
    tider.sokMedian = median(s);
    tider.merkMedian = median(m);
    tider.nyVersjonMedian = median(v);
    expect(s.length).toBe(10);
    // Tidsgrensen kommer fra vi.setConfig({ testTimeout: TIDSGRENSE_MS }) øverst i fila.
  });

  it('skriver tidene (performance.now) til loggen', () => {
    // Tallene er for rapporten, ikke en grense: maskinen og jsdom avgjør nivået.

    console.log(
      `Ytelsesmåling (${process.env.KO_TAVLE_JS ? 'annen tavle.js' : 'denne'}): ` +
        Object.entries(tider)
          .map(([k, v]) => `${k}=${v.toFixed(1)}ms`)
          .join(' '),
    );
    expect(Object.keys(tider).length).toBeGreaterThan(0);
  });
});
