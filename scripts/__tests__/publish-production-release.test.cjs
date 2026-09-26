'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { nextVersion, planRelease, publishRelease } = require('../publish-production-release.cjs');

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const PLAN = { sha: SHA, tag: 'v3.0.1', previousTag: 'v3.0.0', existingTag: false, makeLatest: true };
const RUN_URL = 'https://github.com/example/site/actions/runs/123';

function repository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zvenfit-estetika-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  const commit = message => {
    git('commit', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  commit('chore: initial version');
  git('tag', 'v3.0.0');
  return { git, commit };
}

function api({ tagSha = null, release = null, failPublish = false, annotated = false } = {}) {
  const state = { tagSha, release, failPublish, writes: [], calls: [] };
  const request = async (method, route, body) => {
    state.calls.push({ method, route, body });
    if (method === 'POST') state.writes.push({ route, body });
    if (method === 'GET' && route.startsWith('/git/ref/tags/') && state.tagSha) {
      return { object: { type: annotated ? 'tag' : 'commit', sha: state.tagSha } };
    }
    if (method === 'GET' && route.startsWith('/git/tags/') && annotated) {
      return { object: { type: 'commit', sha: state.tagSha } };
    }
    if (method === 'GET' && route.startsWith('/releases/tags/') && state.release) return state.release;
    if (method === 'POST' && route === '/releases/generate-notes')
      return { body: 'Changes since the previous version.' };
    if (method === 'POST' && route === '/git/refs') {
      state.tagSha = body.sha;
      return { object: { type: 'commit', sha: body.sha } };
    }
    if (method === 'POST' && route === '/releases') {
      if (state.failPublish) throw Object.assign(new Error('Temporary API failure'), { status: 503 });
      state.release = { ...body, html_url: `https://github.com/example/site/releases/tag/${body.tag_name}` };
      return state.release;
    }
    throw Object.assign(new Error('Not found'), { status: 404 });
  };
  return { state, request };
}

test('version policy uses all unreleased changes and explicit breaking markers', () => {
  assert.equal(nextVersion('v3.0.0', ['fix: recover reads', 'chore: update CI']), 'v3.0.1');
  assert.equal(nextVersion('v3.0.8', ['feat(schedule): add filtering', 'fix: align labels']), 'v3.1.0');
  assert.equal(nextVersion('v3.9.8', ['feat!: replace the lead API']), 'v4.0.0');
  assert.equal(nextVersion('v3.9.8', ['fix(api)!: require a new payload']), 'v4.0.0');
  assert.equal(nextVersion('v3.9.8', ['refactor: update contract\n\nBREAKING CHANGE: payload changed']), 'v4.0.0');
});

test('the first verified deployment bootstraps v0.1.0 without historical tags', t => {
  const { git, commit } = repository(t);
  git('tag', '-d', 'v3.0.0');
  const sha = commit('feat!: accumulated changes before release automation');
  const expected = { sha, tag: 'v0.1.0', previousTag: undefined, existingTag: false, makeLatest: true };
  assert.deepEqual(planRelease(sha, git), expected);
  git('tag', 'archive/old-site');
  git('tag', 'v99.0.0-rc.1');
  assert.deepEqual(planRelease(sha, git), expected);
  git('tag', 'v0.1.0');
  assert.deepEqual(planRelease(sha, git), { ...expected, existingTag: true });
  assert.equal(planRelease(commit('fix: next deployment'), git).tag, 'v0.1.1');
});

test('initial publication omits the previous tag and resumes after a partial failure', async () => {
  const plan = { ...PLAN, tag: 'v0.1.0', previousTag: undefined };
  const { state, request } = api({ failPublish: true });
  await assert.rejects(publishRelease(plan, request, RUN_URL), /Temporary API failure/);
  assert.deepEqual(state.writes[0].body, { tag_name: 'v0.1.0', target_commitish: SHA });
  state.failPublish = false;
  state.writes = [];
  await publishRelease({ ...plan, existingTag: true }, request, RUN_URL);
  assert.equal(state.release.tag_name, 'v0.1.0');
  assert.equal(state.release.target_commitish, SHA);
  assert.ok(!state.writes.some(write => write.route === '/git/refs'));
});

test('plan uses the deployed checkout, ignores archive/prerelease tags, and sorts numerically', t => {
  const { git, commit } = repository(t);
  git('tag', 'v3.9.0');
  git('tag', 'v3.10.0');
  git('tag', 'v99.0.0-rc.1');
  git('tag', 'archive/legacy-landing');
  commit('feat: add a page');
  const sha = commit('fix: adjust its layout');
  const plan = planRelease(sha, git);
  assert.equal(plan.tag, 'v3.11.0');
  assert.equal(plan.previousTag, 'v3.10.0');
  assert.equal(plan.sha, sha);
  assert.throws(() => planRelease(OTHER_SHA, git), /Checkout does not match/);
  assert.throws(() => planRelease('main', git), /full commit SHA/);
});

test('existing annotated version is reused after a partial publication failure', t => {
  const { git, commit } = repository(t);
  const sha = commit('fix: recover queue reads');
  git('tag', '-a', 'v3.0.1', '-m', 'Version 3.0.1');
  assert.deepEqual(planRelease(sha, git), { ...PLAN, sha, existingTag: true });
});

test('an older untagged deployment cannot allocate a version after a newer release', t => {
  const { git, commit } = repository(t);
  const oldSha = commit('fix: old deployment');
  commit('fix: newer deployment');
  git('tag', 'v3.0.1');
  git('checkout', '--detach', oldSha);
  assert.throws(() => planRelease(oldSha, git));
});

test('repairing an older existing tag does not make it the latest release', t => {
  const { git, commit } = repository(t);
  const oldSha = commit('fix: old deployment');
  git('tag', 'v3.0.1');
  commit('feat: newer deployment');
  git('tag', 'v3.1.0');
  git('checkout', '--detach', oldSha);
  assert.deepEqual(planRelease(oldSha, git), { ...PLAN, sha: oldSha, existingTag: true, makeLatest: false });
});

test('divergent history and ambiguous stable tags fail closed', t => {
  const { git, commit } = repository(t);
  const base = git('rev-parse', 'HEAD');
  commit('fix: deployed change');
  git('tag', 'v3.0.1');
  git('checkout', '--detach', base);
  const sha = commit('fix: divergent deployment');
  assert.throws(() => planRelease(sha, git));
  git('tag', 'v3.1.0');
  git('tag', 'v3.2.0');
  assert.throws(() => planRelease(sha, git), /Multiple stable version tags/);
});

test('publication pins the tag, notes, and release to the deployed SHA', async () => {
  const { state, request } = api();
  const result = await publishRelease(PLAN, request, RUN_URL);
  assert.equal(result.created, true);
  assert.equal(state.tagSha, SHA);
  assert.deepEqual(
    state.writes.map(write => write.route),
    ['/releases/generate-notes', '/git/refs', '/releases'],
  );
  assert.deepEqual(state.writes[0].body, { tag_name: 'v3.0.1', target_commitish: SHA, previous_tag_name: 'v3.0.0' });
  assert.equal(state.release.target_commitish, SHA);
  assert.equal(state.release.make_latest, 'true');
  assert.ok(state.release.body.includes(RUN_URL));
  assert.ok(state.release.body.includes(SHA));
});

test('rerun of a published commit performs no writes', async () => {
  const { state, request } = api({
    tagSha: SHA,
    release: { draft: false, prerelease: false, html_url: 'release-url' },
  });
  assert.deepEqual(await publishRelease({ ...PLAN, existingTag: true }, request, RUN_URL), {
    tag: 'v3.0.1',
    url: 'release-url',
    created: false,
  });
  assert.deepEqual(state.writes, []);
});

test('rerun after tag creation resumes the same version without creating another tag', async () => {
  const { state, request } = api({ failPublish: true });
  await assert.rejects(publishRelease(PLAN, request, RUN_URL), /Temporary API failure/);
  assert.equal(state.tagSha, SHA);
  state.failPublish = false;
  state.writes = [];
  await publishRelease({ ...PLAN, existingTag: true, makeLatest: false }, request, RUN_URL);
  assert.deepEqual(
    state.writes.map(write => write.route),
    ['/releases/generate-notes', '/releases'],
  );
  assert.equal(state.release.tag_name, 'v3.0.1');
  assert.equal(state.release.make_latest, 'false');
});

test('a remote tag on another commit is never moved or published', async () => {
  const { state, request } = api({ tagSha: OTHER_SHA });
  await assert.rejects(publishRelease(PLAN, request, RUN_URL), /another commit/);
  assert.deepEqual(state.writes, []);
});

test('annotated tags resolve to their underlying commit', async () => {
  const { state, request } = api({ tagSha: SHA, annotated: true });
  await publishRelease({ ...PLAN, existingTag: true }, request, RUN_URL);
  assert.equal(state.release.target_commitish, SHA);
  assert.ok(!state.writes.some(write => write.route === '/git/refs'));
});

test('a deleted existing tag is not recreated and a manual draft is not published', async () => {
  const missing = api();
  await assert.rejects(publishRelease({ ...PLAN, existingTag: true }, missing.request, RUN_URL), /disappeared/);
  assert.deepEqual(missing.state.writes, []);
  const draft = api({ tagSha: SHA, release: { draft: true } });
  await assert.rejects(publishRelease(PLAN, draft.request, RUN_URL), /not an existing stable release/);
  assert.deepEqual(draft.state.writes, []);
});

test('authentication failures do not masquerade as a missing release', async () => {
  const { state, request } = api({ tagSha: SHA });
  const denied = async (method, route, body) => {
    if (route.startsWith('/releases/tags/')) throw Object.assign(new Error('Forbidden'), { status: 403 });
    return request(method, route, body);
  };
  await assert.rejects(publishRelease(PLAN, denied, RUN_URL), /Forbidden/);
  assert.deepEqual(state.writes, []);
});

test('tag creation races only resume when the competing tag has the same SHA', async () => {
  for (const competingSha of [SHA, OTHER_SHA]) {
    const { state, request } = api();
    const racingRequest = async (method, route, body) => {
      if (method === 'POST' && route === '/git/refs') {
        state.tagSha = competingSha;
        throw Object.assign(new Error('Reference already exists'), { status: 422 });
      }
      return request(method, route, body);
    };
    if (competingSha === SHA) {
      await publishRelease(PLAN, racingRequest, RUN_URL);
      assert.equal(state.release.target_commitish, SHA);
    } else {
      await assert.rejects(publishRelease(PLAN, racingRequest, RUN_URL), /Reference already exists/);
      assert.equal(state.release, null);
    }
  }
});

test('a tag moved during notes generation is not published', async () => {
  const { state, request } = api({ tagSha: SHA });
  const racingRequest = async (method, route, body) => {
    const response = await request(method, route, body);
    if (route === '/releases/generate-notes') state.tagSha = OTHER_SHA;
    return response;
  };
  await assert.rejects(publishRelease(PLAN, racingRequest, RUN_URL), /no longer matches/);
  assert.equal(state.release, null);
});

test('workflow gates publication on production smoke and confines write permission to that job', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/main.yml'), 'utf8');
  const release = workflow.slice(workflow.indexOf('\n  release:'));
  const smoke = workflow.slice(workflow.indexOf('\n  smoke-production:'), workflow.indexOf('\n  release:'));
  const preflight = workflow.slice(workflow.indexOf('\n  deploy-preflight:'), workflow.indexOf('\n  verify-ydb:'));
  assert.match(release, /needs: smoke-production/);
  for (const job of [release, preflight]) {
    assert.match(job, /if: github.event_name != 'pull_request' && github.ref == 'refs\/heads\/main'/);
  }
  assert.match(smoke, /needs: \[deploy-function, deploy-site\]/);
  assert.match(smoke, /run: node scripts\/smoke-production.cjs/);
  assert.doesNotMatch(smoke, /always\(\)|continue-on-error/);
  assert.doesNotMatch(release, /always\(\)|continue-on-error/);
  assert.doesNotMatch(release, /id-token:|environment:|secrets\./);
  assert.match(release, /ref: \$\{\{ github.sha \}\}/);
  assert.match(release, /RELEASE_SHA: \$\{\{ github.sha \}\}/);
  assert.match(release, /fetch-depth: 0/);
  assert.match(release, /persist-credentials: false/);
  assert.match(release, /contents: write/);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf('\n  release:')), /contents: write/);
  assert.match(workflow, /group: deploy-production\n\s+cancel-in-progress: false/);
});
