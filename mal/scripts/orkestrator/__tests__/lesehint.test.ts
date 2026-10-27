// =============================================================
// lesehint.test.ts: myke lese- og rapporthint for spor-agentene.
//
// Låser: hint (aldri blokk) ved hel lesing over 300 linjer og ved samme fil hel to ganger, ingen effekt for utdrag,
// andre agenttyper eller hovedøkta; rapportpåminnelsen kommer én gang over terskelen; utskriftshintet kommer
// for store Bash-/PowerShell-resultat i spor, høyst BASH_HINT_MAKS ganger. Til slutt røyktester av hook-lesevakt.mjs og
// hook-spor-kontekst.mjs som barneprosesser (temp-filer).
// =============================================================
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BASH_HINT_MAKS,
  kommandoType,
  utskriftLengde,
  vurderBashHint,
  vurderLeseHint,
  vurderRapportHint,
} from '../lesehint';

describe('vurderLeseHint', () => {
  const base = { agentType: 'spor', filsti: 'C:\\x\\Stor.ts', antallLinjer: 500 };

  it('hint ved hel lesing over grensen, og fila huskes', () => {
    const r = vurderLeseHint(base);
    expect(r?.hint).toMatch(/500 linjer/);
    expect(r?.nokkel).toBe('c:/x/stor.ts');
  });

  it('samme fil hel to ganger gir hint, også for små filer', () => {
    const r = vurderLeseHint({ ...base, antallLinjer: 10, lestHele: ['c:/x/stor.ts'] });
    expect(r?.hint).toMatch(/allerede lest/);
    expect(r?.nokkel).toBeNull();
  });

  it('liten fil første gang: ingen melding, men huskes', () => {
    expect(vurderLeseHint({ ...base, antallLinjer: 100 })).toEqual({
      nokkel: 'c:/x/stor.ts',
      hint: '',
    });
  });

  it('ingen effekt for utdrag, andre agenttyper, hovedøkta og bilder', () => {
    expect(vurderLeseHint({ ...base, limit: 50 })).toBeNull();
    expect(vurderLeseHint({ ...base, offset: 1 })).toBeNull();
    expect(vurderLeseHint({ ...base, agentType: 'general-purpose' })).toBeNull();
    expect(vurderLeseHint({ ...base, agentType: null })).toBeNull();
    expect(vurderLeseHint({ ...base, filsti: 'C:\\x\\bilde.PNG' })).toBeNull();
  });
});

describe('vurderRapportHint', () => {
  it('én gang over terskelen, bare for spor', () => {
    expect(vurderRapportHint({ agentType: 'spor', kontekst: 199_000 })).toBeNull();
    expect(vurderRapportHint({ agentType: 'spor-d', kontekst: 201_000 })).toMatch(/rapport\.md/);
    expect(vurderRapportHint({ agentType: 'spor', kontekst: 250_000, sagt: true })).toBeNull();
    expect(vurderRapportHint({ agentType: 'general-purpose', kontekst: 250_000 })).toBeNull();
  });
});

describe('hook-lesevakt.mjs (røyktest)', () => {
  const hook = path.resolve(__dirname, '..', 'hook-lesevakt.mjs');
  const kjor = (inn: object, tilstand: string) =>
    spawnSync(process.execPath, [hook], {
      input: JSON.stringify(inn),
      encoding: 'utf8',
      env: { ...process.env, LESEHINT_TILSTAND: tilstand },
    });

  it('gir lesehint (ikke deny) for stor fil, og hint om gjentatt hel lesing', () => {
    const mappe = fs.mkdtempSync(path.join(os.tmpdir(), 'lesehint-'));
    const fil = path.join(mappe, 'stor.ts');
    fs.writeFileSync(fil, 'x\n'.repeat(400));
    const liten = path.join(mappe, 'liten.ts');
    fs.writeFileSync(liten, 'x\n');
    const tilstand = path.join(mappe, 'tilstand');
    const inn = { agent_type: 'spor', agent_id: 'a1', tool_input: { file_path: fil } };
    const en = JSON.parse(kjor(inn, tilstand).stdout);
    expect(en.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(en.hookSpecificOutput.additionalContext).toMatch(/401 linjer/);
    const lite1 = kjor({ ...inn, tool_input: { file_path: liten } }, tilstand).stdout;
    expect(lite1).toBe('');
    const lite2 = JSON.parse(kjor({ ...inn, tool_input: { file_path: liten } }, tilstand).stdout);
    expect(lite2.hookSpecificOutput.additionalContext).toMatch(/allerede lest/);
    // utdrag og hovedøkta: ingen utskrift
    expect(kjor({ ...inn, tool_input: { file_path: fil, limit: 10 } }, tilstand).stdout).toBe('');
    expect(kjor({ tool_input: { file_path: fil } }, tilstand).stdout).toBe('');
    fs.rmSync(mappe, { recursive: true, force: true });
  });
});

describe('utskriftLengde og kommandoType', () => {
  it('teller stdout + stderr, strenger, output og innholdsblokker', () => {
    expect(utskriftLengde({ stdout: 'abc', stderr: 'de', interrupted: false })).toBe(5);
    expect(utskriftLengde('abcd')).toBe(4);
    expect(utskriftLengde({ output: 'xy' })).toBe(2);
    expect(utskriftLengde([{ type: 'text', text: 'abc' }])).toBe(3);
    expect(utskriftLengde(null)).toBe(0);
    expect(utskriftLengde(42)).toBe(0);
  });

  it('kjenner igjen kategoriene', () => {
    expect(kommandoType("psql -XAtc 'select pg_get_functiondef(...)'")).toBe('psql');
    expect(kommandoType('grep -rn foo src')).toBe('grep');
    expect(kommandoType('rg -n foo')).toBe('grep');
    expect(kommandoType('Select-String -Path x -Pattern y')).toBe('grep');
    expect(kommandoType('sed -n 1,400p x.sql')).toBe('les');
    expect(kommandoType('cat stor.sql')).toBe('les');
    expect(kommandoType('Get-Content x.sql')).toBe('les');
    expect(kommandoType('npx vitest')).toBe('annet');
    expect(kommandoType('concatenate')).toBe('annet');
  });
});

describe('vurderBashHint', () => {
  const base = { agentType: 'spor', verktoy: 'Bash', kommando: 'grep -rn x .', lengde: 20_000 };

  it('hint over terskelen, tilpasset kommandoen', () => {
    expect(vurderBashHint(base)).toMatch(/20k tegn.*grep -m/);
    expect(vurderBashHint({ ...base, kommando: 'sed -n 1,900p a.sql' })).toMatch(/sed -n 'a,bp'/);
    expect(
      vurderBashHint({ ...base, agentType: 'spor-d', kommando: 'psql -c "select *"' }),
    ).toMatch(/psql: velg smalt/);
    expect(vurderBashHint({ ...base, verktoy: 'PowerShell', kommando: 'npm test' })).toMatch(
      /\| head/,
    );
  });

  it('ingen effekt under terskelen, for andre verktøy, agenttyper, hovedøkta eller etter maks', () => {
    expect(vurderBashHint({ ...base, lengde: 15_000 })).toBeNull();
    expect(vurderBashHint({ ...base, lengde: null })).toBeNull();
    expect(vurderBashHint({ ...base, verktoy: 'Read' })).toBeNull();
    expect(vurderBashHint({ ...base, agentType: 'general-purpose' })).toBeNull();
    expect(vurderBashHint({ ...base, agentType: null })).toBeNull();
    expect(vurderBashHint({ ...base, gitt: BASH_HINT_MAKS })).toBeNull();
    expect(vurderBashHint({ ...base, gitt: BASH_HINT_MAKS - 1 })).not.toBeNull();
  });
});

describe('hook-spor-kontekst.mjs (røyktest, utskriftshint)', () => {
  const hook = path.resolve(__dirname, '..', 'hook-spor-kontekst.mjs');
  const kjor = (inn: object, tilstand: string) =>
    spawnSync(process.execPath, [hook], {
      input: JSON.stringify(inn),
      encoding: 'utf8',
      env: { ...process.env, SPOR_KONTEKST_TILSTAND: tilstand },
    });

  it('stor Bash-utskrift gir hint høyst BASH_HINT_MAKS ganger; liten utskrift og hovedøkta gir ingenting', () => {
    const mappe = fs.mkdtempSync(path.join(os.tmpdir(), 'bashhint-'));
    const tilstand = path.join(mappe, 'tilstand');
    const inn = {
      agent_type: 'spor',
      agent_id: 'b1',
      tool_name: 'Bash',
      tool_input: { command: 'grep -rn x src' },
      tool_response: { stdout: 'x'.repeat(16_000), stderr: '' },
    };
    for (let i = 0; i < BASH_HINT_MAKS; i++) {
      const ut = JSON.parse(kjor(inn, tilstand).stdout);
      expect(ut.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(ut.hookSpecificOutput.additionalContext).toMatch(/\[utskriftshint\].*grep -m/);
    }
    expect(kjor(inn, tilstand).stdout).toBe('');
    const liten = { ...inn, agent_id: 'b2', tool_response: { stdout: 'kort', stderr: '' } };
    expect(kjor(liten, tilstand).stdout).toBe('');
    const { agent_type: _bort, ...hoved } = inn;
    expect(kjor({ ...hoved, agent_id: 'b3' }, tilstand).stdout).toBe('');
    fs.rmSync(mappe, { recursive: true, force: true });
  });
});
