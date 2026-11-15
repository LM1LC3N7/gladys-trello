// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. When the Gladys
// core is cloned next to this repository (~/code/Gladys), its own manifest
// validator is run too.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTION_TEST,
  BOUNDS,
  CONFIG_BOARDS,
  CONFIG_KEY,
  CONFIG_POLL,
  CONFIG_SOON,
  CONFIG_TOKEN,
  CONFIG_TZ,
  DEFAULTS,
  DEFAULT_TZ,
  GET_ONLY,
  POSITIONS,
  SCENE_CREATE,
  SCENE_GET,
  SCENE_MOVE,
  TRIGGER_DUE,
  TRIGGER_MOVED,
  WIDGET_CARDS,
} from '../src/constants.js';
import { parseBoard } from '../src/trello.js';
import { dueData, moveEvents } from '../src/triggers.js';
import { BOARD_HOME, LIST_DONE, board, card } from './fixtures/trello.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

function* objects(node) {
  if (Array.isArray(node)) {
    for (const item of node) yield* objects(item);
  } else if (node && typeof node === 'object') {
    yield node;
    for (const value of Object.values(node)) yield* objects(value);
  }
}

const keys = (list) => list.map((x) => x.key);

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'provider');
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.deepEqual(manifest.categories, ['services']);
  assert.deepEqual(manifest.transports, ['cloud']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /^Unofficial/);
  assert.match(manifest.description.fr, /^Non officiel/);
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined, 'Trello is used everywhere');
});

test('one version everywhere, semver, never pinned by hand twice', () => {
  const semver = /^\d+\.\d+\.\d+$/;
  assert.match(pkg.version, semver);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-trello:${pkg.version}`);
  assert.match(manifest.gladys_version, /^>=\d+\.\d+\.\d+$/, 'a range, never one version');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
});

test('every text is bilingual, and the words the rules forbid are absent', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
  const all = [
    'gladys-assistant-integration.json',
    'README.md',
    'docs/en.md',
    'docs/fr.md',
    'src/i18n.js',
    'CHANGELOG.md',
  ]
    .map(read)
    .join('\n');
  assert.doesNotMatch(all, /chiffr|encrypt|hachage/i);
});

test('the configuration: two secrets without default, defaults and bounds as in the code', () => {
  for (const field of manifest.config_schema) {
    assert.doesNotMatch(field.key, /^gladys_/i);
    for (const link of field.links ?? []) assert.match(link.url, /^https:\/\//);
  }
  for (const [name, gender] of [
    [CONFIG_KEY, 'e'],
    [CONFIG_TOKEN, ''],
  ]) {
    const field = manifest.config_schema.find((f) => f.key === name);
    assert.equal(field.type, 'secret');
    assert.equal(field.required, true);
    assert.equal(field.default, undefined, 'never a default secret');
    assert.match(
      field.description.en,
      /Kept by Gladys in its database, never shown again, sent only to Trello\./,
    );
    assert.ok(
      field.description.fr.includes(
        `Gardé${gender} par Gladys dans sa base, jamais réaffiché${gender}, envoyé${gender} seulement à Trello.`,
      ),
      field.description.fr,
    );
  }
  for (const name of [CONFIG_POLL, CONFIG_SOON]) {
    const field = manifest.config_schema.find((f) => f.key === name);
    assert.equal(field.default, DEFAULTS[name], name);
    assert.deepEqual([field.min, field.max], BOUNDS[name], name);
  }
  assert.deepEqual(
    manifest.config_schema.filter((f) => f.type !== 'section').map((f) => f.key),
    [CONFIG_KEY, CONFIG_TOKEN, CONFIG_BOARDS, CONFIG_POLL, CONFIG_SOON, CONFIG_TZ],
  );
  const tz = manifest.config_schema.find((f) => f.key === CONFIG_TZ);
  assert.match(tz.description.en, new RegExp(DEFAULT_TZ));
  assert.deepEqual(keys(manifest.actions), [ACTION_TEST]);
  assert.ok(handlers.includes('onAction(ACTION_TEST'));
});

test('the scene declarations and the widget match the code', () => {
  assert.deepEqual(keys(manifest.widgets), [WIDGET_CARDS]);
  assert.deepEqual(keys(manifest.scene_triggers), [TRIGGER_DUE, TRIGGER_MOVED]);
  assert.deepEqual(keys(manifest.scene_actions), [SCENE_CREATE, SCENE_MOVE, SCENE_GET]);
  for (const name of ['SCENE_CREATE', 'SCENE_MOVE', 'SCENE_GET']) {
    assert.ok(handlers.includes(`onSceneAction(${name},`), name);
  }
  assert.ok(handlers.includes('onWidgetGet(WIDGET_CARDS,'));
  // The trigger variables are exactly the keys of the published data.
  const snap = parseBoard(board({ cards: [card(1)] }), BOARD_HOME);
  const moved = parseBoard(board({ cards: [card(1, { idList: LIST_DONE })] }), BOARD_HOME);
  const due = { ...dueData(snap, snap.cards.get(card(1).id)), due_local: null };
  const move = { ...moveEvents(snap, moved, new Map(), 0)[0].data, due_local: null };
  const [tDue, tMoved] = manifest.scene_triggers;
  assert.deepEqual(keys(tDue.variables).sort(), Object.keys(due).sort());
  assert.deepEqual(keys(tMoved.variables).sort(), Object.keys(move).sort());
  // Each filter field is a key of the data (the core matches on equality).
  for (const trigger of manifest.scene_triggers) {
    for (const field of trigger.fields) assert.ok(field.key in due, field.key);
  }
  const position = (action) =>
    manifest.scene_actions.find((a) => a.key === action).fields.find((f) => f.key === 'position');
  assert.deepEqual(
    position(SCENE_CREATE).options.map((o) => o.value),
    POSITIONS,
  );
  assert.deepEqual(
    position(SCENE_MOVE).options.map((o) => o.value),
    POSITIONS,
  );
  const only = manifest.scene_actions
    .find((a) => a.key === SCENE_GET)
    .fields.find((f) => f.key === 'only');
  assert.deepEqual(
    only.options.map((o) => o.value),
    GET_ONLY,
  );
  // No required field without default added later would break scenes: noted here.
  for (const action of manifest.scene_actions) {
    assert.ok(action.timeout_seconds >= 30, action.key);
  }
});

test('the source is named in the manifest, the docs and the notices; licence files in the image', () => {
  const intro = manifest.config_schema.find((f) => f.key === 'intro');
  for (const lang of ['en', 'fr']) {
    assert.match(intro.description[lang], /api\.trello\.com/);
    assert.match(intro.description[lang], /^(Unofficial|Intégration non officielle)/);
  }
  for (const file of ['README.md', 'docs/en.md', 'docs/fr.md', 'THIRD_PARTY_NOTICES.md']) {
    assert.match(read(file), /api\.trello\.com/, file);
  }
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  assert.doesNotMatch(read('LICENSE'), /Copyright \d{4} [A-Z]/, 'no personal name');
});

test('every select option follows the core rules (label, value, unique)', () => {
  for (const node of objects(manifest)) {
    if (node.type !== 'select' || !Array.isArray(node.options)) continue;
    const values = node.options.map((o) => o.value);
    assert.equal(new Set(values).size, values.length);
    for (const option of node.options) {
      assert.ok(typeof option.value === 'string' || Number.isInteger(option.value));
      assert.deepEqual(Object.keys(option).sort(), ['label', 'value']);
      for (const l of Object.values(option.label)) {
        assert.equal(typeof l, 'string');
        assert.ok(l.length > 0 && l === l.trim());
      }
    }
  }
  assert.equal(
    JSON.stringify(manifest).includes('supported_options'),
    false,
    'no feature published',
  );
});

const core = join(homedir(), 'code/Gladys/server/lib');
const coreCloned = existsSync(
  join(core, 'external-integration/externalIntegration.validateManifest.js'),
);

test(
  'the Gladys core validator accepts the manifest',
  { skip: !coreCloned && 'Gladys core not cloned' },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'trello-core-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const script = `
      const mod = require(${JSON.stringify(join(core, 'external-integration/externalIntegration.validateManifest.js'))});
      const validate = mod.validateManifest ?? mod;
      let out;
      try { validate(${JSON.stringify(manifest)}); out = 'ok'; } catch (err) { out = err.message; }
      console.log('RESULT' + JSON.stringify(out));
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const line = result.stdout.split('\n').find((l) => l.startsWith('RESULT'));
    assert.ok(line, `${result.stdout}\n${result.stderr}`.slice(-2000));
    assert.equal(JSON.parse(line.slice(6)), 'ok');
  },
);
