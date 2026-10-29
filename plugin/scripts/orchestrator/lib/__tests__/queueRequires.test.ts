// The `requires` field: resources beyond the repo on the remote decide whether a task can run in the cloud.
import { describe, expect, test } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic.js');

const queue = (requires?: string[]) => ({
  tasks: [{ id: 'X-1', title: 'x', class: 'K', status: 'waiting', requires }],
  resolved: [],
});
const assess = (requires?: string[]) =>
  L.cloudSuitable(queue(requires), 'X-1', { pushedHead: 'abc', changed: [], missionText: '', ownPath: null });

describe('requires and the cloud', () => {
  test('without requires a simple K task is suitable', () => {
    expect(assess().suitable).toBe(true);
  });

  test.each(['db', 'web', 'sources', 'local-files', 'unit'])(
    '%s keeps the task local',
    (k: string) => {
      const v = assess([k]);
      expect(v.suitable).toBe(false);
      expect(v.reasons.length).toBeGreaterThan(0);
    },
  );

  test('deploy does not block (the orchestrator deploys after the merge)', () => {
    expect(assess(['deploy']).suitable).toBe(true);
  });

  test('validateNewField rejects unknown values and accepts known ones', () => {
    expect(L.validateNewField({ requires: ['junk'] }, {})).not.toEqual([]);
    expect(L.validateNewField({ requires: 'db' }, {})).not.toEqual([]);
    expect(L.validateNewField({ requires: ['db', 'deploy'] }, {})).toEqual([]);
  });
});
