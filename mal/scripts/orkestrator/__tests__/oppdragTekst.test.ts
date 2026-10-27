// =============================================================
// oppdragTekst.test.ts: felles protokoll per klasse og seksjonspekere.
//
// Låser: (1) hvert bindende nøkkelkrav havner i prompten for de klassene det gjelder, bygd fra den EKTE oppdragsmalen
// (docs/mission-template.md i repo-rota, som installeres som docs/ko/mission-template.md) slik lag-ko-felles.mjs og
// lag-oppdrag.mjs gjør det; (2) K og U får ikke D-delene, og U heller ikke klientreglene; (3) ukjent klasse gir hele
// protokollen; (4) prosjektets konfig (prosjektnavn, basegren, gater, arkitekturregler) fylles inn; (5) seksjonspekere
// får linjeområdet.
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  filtrerKlasse,
  gateTekst,
  klasseFraBlokk,
  lagKoFelles,
  seksjonsOmraade,
  seksjonsPekere,
} from '../oppdragTekst';

// Repo-rota: tre nivåer over mal/scripts/orkestrator (testen ligger i __tests__ under den).
const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const MAL = fs.readFileSync(path.join(REPO, 'docs', 'mission-template.md'), 'utf8');
const KONFIG = {
  prosjektNavn: 'Eksempel',
  baseGren: 'main',
  gater: { rask: ['npm run lint'], full: ['npm run lint', 'npm test'] },
  arkitekturRegler: ['UI importerer aldri databaseklienten direkte.'],
};
const FELLES = lagKoFelles(MAL, 'C:\\scratch', KONFIG);
const prompt = (k: string | null) => filtrerKlasse(FELLES, k);

const ALLE = ['K', 'D', 'D+', 'U'];
const DB = ['D', 'D+'];
const KODE = ['K', 'D', 'D+'];

// [nøkkelord, klassene som MÅ få det]. Lista er de bindende kravene i protokollen.
const KRAV: [string, string[]][] = [
  // alle klasser
  ['klargjor-spor.mjs', ALLE],
  ['NEKTER', ALLE],
  ['npm install', ALLE],
  ['NEVER push', ALLE],
  ['git commit -- <files>', ALLE],
  ['conflict markers', ALLE],
  ['NEVER kill by pattern', ALLE],
  ['hotspots', ALLE],
  ['ko.mjs add --fil', ALLE],
  ['HIGH security finding', ALLE],
  ['Context cap about 300k', ALLE],
  ['overlevering.md', ALLE],
  ['git switch --detach', ALLE],
  ['No sleep, poll or wait loops', ALLE],
  ['never read them', ALLE],
  ['offset`/`limit', ALLE],
  ['NEVER write your own check script', ALLE],
  ['gater.mjs --rask', ALLE],
  ['RESULTAT status=FERDIG|DELVIS', ALLE],
  ['at most about 1,500 characters', ALLE],
  ['rapport.md', ALLE],
  ['owner questions', ALLE],
  ['wiring specification', ALLE],
  // fra konfigen
  ['for Eksempel', ALLE],
  ['Base branch: `main`', ALLE],
  ['Quick gate: `npm run lint`', ALLE],
  ['Full gate: `npm run lint`, `npm test`', ALLE],
  ['UI importerer aldri databaseklienten direkte.', ALLE],
  ['git checkout -B __GREN__ main', ALLE],
  // K, D og D+ (kode)
  ['Append-only shared files', KODE],
  ['Client code', KODE],
  // K og U
  ['Before delivery, K and U', ['K', 'U']],
  // D og D+
  ['Before delivery, D and D+', DB],
  ['Only your own migration block (__BLOKK__)', DB],
  ['capabilities or permissions, never role names', DB],
  ['FULL from the live definition', DB],
  ['Red first', DB],
  ['Self-review (D and D+)', DB],
  ['For D and D+ also', DB],
];

// Det D-delene bare skal ha: K og U får dem ikke.
const BARE_DB = [
  'Only your own migration block',
  'Self-review (D and D+)',
  'Before delivery, D and D+',
  'For D and D+ also',
];

describe('felles protokoll per klasse', () => {
  it.each(KRAV)('«%s» er med for riktige klasser', (ord, klasser) => {
    for (const k of klasser) expect([k, prompt(k).includes(ord)]).toEqual([k, true]);
    expect(prompt(null).includes(ord)).toBe(true); // ukjent klasse: alt
  });

  it('K og U får ikke D-delene, U heller ikke klientreglene og tilleggsfilene', () => {
    for (const ord of BARE_DB) {
      expect([ord, prompt('K').includes(ord)]).toEqual([ord, false]);
      expect([ord, prompt('U').includes(ord)]).toEqual([ord, false]);
    }
    expect(prompt('U').includes('Client code')).toBe(false);
    expect(prompt('U').includes('Append-only shared files')).toBe(false);
    expect(prompt('D').includes('Before delivery, K and U')).toBe(false);
  });

  it('ingen markører eller ufylte plassholdere i prompten', () => {
    for (const k of [...ALLE, null]) {
      expect(prompt(k)).not.toMatch(/<!--/);
      expect(prompt(k)).not.toMatch(/<[A-ZÆØÅ_]+>/);
      expect(prompt(k)).not.toContain('<base>');
    }
  });

  it('K og U er vesentlig kortere enn hele protokollen', () => {
    expect(prompt('K').length).toBeLessThan(prompt(null).length * 0.9);
    expect(prompt('U').length).toBeLessThan(prompt('K').length);
  });

  it('uten konfig: nøytrale standarder (main, ingen gater, ingen regler)', () => {
    const t = lagKoFelles(MAL, 'C:\\scratch');
    expect(t).toContain('Base branch: `main`');
    expect(t).toContain('Quick gate: none set up in ko.config.json');
    expect(t).not.toContain('The project architecture rules');
    expect(gateTekst(undefined)).toBe('none set up in ko.config.json');
    expect(gateTekst(['a', '', 'b'])).toBe('`a`, `b`');
  });

  it('krever overskriften «## Felles protokoll» i malen', () => {
    expect(() => lagKoFelles('# tom mal', 'C:\\scratch')).toThrow(/Felles protokoll/);
  });
});

describe('filtrerKlasse', () => {
  const t =
    'a\n<!-- klasse: D D+ -->\nd\n<!-- /klasse -->\n<!-- klasse: K,U -->\nk\n<!-- /klasse -->\nz';
  it('velger seksjoner per klasse', () => {
    expect(filtrerKlasse(t, 'D+')).toBe('a\nd\nz');
    expect(filtrerKlasse(t, 'U')).toBe('a\nk\nz');
    expect(filtrerKlasse(t, null)).toBe('a\nd\nk\nz');
    expect(filtrerKlasse(t, 'X')).toBe('a\nd\nk\nz');
  });
  it('nøstede seksjoner krever begge', () => {
    const n = '<!-- klasse: K D -->\nkd\n<!-- klasse: D -->\nd\n<!-- /klasse -->\n<!-- /klasse -->';
    expect(filtrerKlasse(n, 'K')).toBe('kd');
    expect(filtrerKlasse(n, 'D')).toBe('kd\nd');
  });
  it('ubalanserte markører er en feil', () => {
    expect(() => filtrerKlasse('<!-- klasse: D -->\nx', 'D')).toThrow();
    expect(() => filtrerKlasse('x\n<!-- /klasse -->', 'D')).toThrow();
  });
});

describe('klasseFraBlokk', () => {
  it('leser klassen fra ## SPOR-linja og KLASSE:-linja', () => {
    expect(klasseFraBlokk('## SPOR X (t; kilde: y; klasse D+, anslag 30 min)')).toBe('D+');
    expect(klasseFraBlokk('## SPOR X (t; kilde: y; klasse D, anslag 30 min)')).toBe('D');
    expect(klasseFraBlokk('## SPOR X (t; klasse K, anslag 90 min)')).toBe('K');
    expect(klasseFraBlokk('KLASSE: U\n## SPOR X (t; klasse D)')).toBe('U');
    expect(klasseFraBlokk('## SPOR X (bølge)')).toBeNull();
    expect(klasseFraBlokk('## SPOR X (t; klasse Kalfa)')).toBeNull();
  });
});

describe('seksjonspekere', () => {
  const dok = [
    '# Tittel', // 1
    '', // 2
    '## 5. Fem', // 3
    'tekst', // 4
    '## 6. Seks', // 5
    'a', // 6
    '### 6.1 Under', // 7
    'b', // 8
    '', // 9
    '## § 7 Sju', // 10
    'c', // 11
  ].join('\n');
  const les = (f: string) => (f === 'docs/a.md' ? dok : null);

  it('beregner linjeområdet for § N, § N.M og #anker', () => {
    expect(seksjonsOmraade(dok, { paragraf: '6' })).toEqual({ fra: 5, til: 8 });
    expect(seksjonsOmraade(dok, { paragraf: '6.1' })).toEqual({ fra: 7, til: 8 });
    expect(seksjonsOmraade(dok, { paragraf: '7' })).toEqual({ fra: 10, til: 11 });
    expect(seksjonsOmraade(dok, { anker: '5-fem' })).toEqual({ fra: 3, til: 4 });
    expect(seksjonsOmraade(dok, { anker: 'under' })).toEqual({ fra: 7, til: 8 });
    expect(seksjonsOmraade(dok, { paragraf: '9' })).toBeNull();
  });

  it('påfører området, også i backticks, og er bakoverkompatibel', () => {
    expect(seksjonsPekere('Les docs/a.md § 6 pkt 1.', les)).toBe(
      'Les docs/a.md § 6 (linje 5–8) pkt 1.',
    );
    expect(seksjonsPekere('Les `docs/a.md#under` nå', les)).toBe(
      'Les `docs/a.md#under` (linje 7–8) nå',
    );
    expect(seksjonsPekere('Les `docs/a.md` § 6.1.', les)).toBe(
      'Les `docs/a.md` § 6.1 (linje 7–8).',
    );
    // uten seksjon, ukjent fil, ukjent seksjon: urørt
    for (const t of ['Les docs/a.md.', 'Les docs/b.md § 6.', 'Les docs/a.md § 9.'])
      expect(seksjonsPekere(t, les)).toBe(t);
  });

  it('er idempotent', () => {
    const en = seksjonsPekere('docs/a.md § 6.1 og `docs/a.md#under`', les);
    expect(seksjonsPekere(en, les)).toBe(en);
  });
});
