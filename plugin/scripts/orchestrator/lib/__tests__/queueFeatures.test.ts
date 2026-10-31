// =============================================================
// queueFeatures.test.ts: the module switches (`features` in queue.config.json, lib/queueConfig.js).
//
// The rule lives in queueConfig.features (pure: the defaults merged with the project's values), so it is tested there,
// plus queue.mjs against a temporary data folder: `cloud` answers "Cloud is off" with exit 0 by default, and works when
// features.cloud is true (never the real queue or the main repo).
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const KK = require('../queueConfig.js') as {
  STANDARD: Record<string, unknown>;
  FEATURES: Record<string, boolean>;
  merge: (a: unknown, b: unknown) => Record<string, unknown>;
  features: (cfg?: unknown) => Record<string, boolean>;
  featureOn: (name: string, cfg?: unknown) => boolean;
  featureOffText: (name: string) => string;
};

/** The configuration the way queueConfig.config() builds it: the defaults merged with the project's file. */
const conf = (own: object = {}) => KK.merge(KK.STANDARD, own);

describe('features (pure)', () => {
  it('has the owner\'s defaults: plans, focus and statistics on; cloud, follow and the Plans parts off', () => {
    expect(KK.features(conf())).toEqual({
      plans: true,
      'plans.legal': false,
      'plans.launch': false,
      'plans.documents': false,
      focus: true,
      statistics: true,
      cloud: false,
      follow: false,
    });
    expect(KK.featureOn('cloud', conf())).toBe(false);
    expect(KK.featureOn('plans', conf())).toBe(true);
  });

  it('merges the project\'s values, and ignores unknown keys and values that are not booleans', () => {
    const f = KK.features(
      conf({ features: { cloud: true, focus: false, 'plans.legal': true, mystery: true, follow: 'yes' } }),
    );
    expect(f.cloud).toBe(true);
    expect(f.focus).toBe(false);
    expect(f['plans.legal']).toBe(true);
    expect(f.follow).toBe(false); // "yes" is not a boolean: the default stays
    expect(f).not.toHaveProperty('mystery');
    expect(KK.featureOn('mystery', conf({ features: { mystery: true } }))).toBe(false);
  });

  it('turns a part off when its parent is off', () => {
    const f = KK.features(conf({ features: { plans: false, 'plans.legal': true } }));
    expect(f.plans).toBe(false);
    expect(f['plans.legal']).toBe(false);
  });

  it('survives a features value that is not an object', () => {
    expect(KK.features({ features: 'off' })).toEqual(KK.FEATURES);
    expect(KK.features({})).toEqual(KK.FEATURES);
  });

  it('writes the off text with the config key', () => {
    expect(KK.featureOffText('cloud')).toBe('Cloud is off (features.cloud in queue.config.json).');
    expect(KK.featureOffText('follow')).toBe('Follow is off (features.follow in queue.config.json).');
  });
});

describe('queue.mjs with the cloud module', () => {
  const QUEUE_MJS = join(__dirname, '..', '..', 'queue.mjs');
  let folder = '';
  const run = (args: string[]) => {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: {
          ...process.env,
          QUEUE_FOLDER: folder,
          QUEUE_GIT: folder,
          QUEUE_ROOT: folder,
          QUEUE_CONFIG: join(folder, 'queue.config.json'),
          QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out };
    } catch (e) {
      const x = e as { status: number; stdout: string };
      return { code: x.status, out: String(x.stdout ?? '') };
    }
  };
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-features-'));
    writeFileSync(join(folder, 'queue.json'), JSON.stringify({ tasks: [], limits: { maxConcurrent: 5 } }));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('answers "Cloud is off" with exit 0 by default, for every cloud command', () => {
    for (const args of [['cloud'], ['cloud', 'start', 'X-1'], ['cloud-package', 'X-1'], ['cloud-bundles']]) {
      const r = run(args);
      expect(r.code).toBe(0);
      expect(r.out.trim()).toBe('Cloud is off (features.cloud in queue.config.json).');
    }
  });

  it('runs the cloud command when features.cloud is true', () => {
    writeFileSync(join(folder, 'queue.config.json'), JSON.stringify({ features: { cloud: true } }));
    const r = run(['cloud']);
    expect(r.out).not.toMatch(/Cloud is off/);
  });

  it('never gates the plan register in the CLI (skills use it)', () => {
    writeFileSync(join(folder, 'queue.config.json'), JSON.stringify({ features: { plans: false } }));
    expect(run(['plan']).out).not.toMatch(/is off/);
  });
});
