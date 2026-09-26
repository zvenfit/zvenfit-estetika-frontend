'use strict';

const { execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');

const VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const INITIAL_VERSION = 'v0.1.0';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function compareVersions(a, b) {
  const left = a.match(VERSION).slice(1).map(BigInt);
  const right = b.match(VERSION).slice(1).map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

function nextVersion(tag, messages) {
  const version = tag.match(VERSION).slice(1).map(BigInt);
  const breaking = messages.some(message => /^[a-z]+(?:\([^\r\n)]+\))?!: |^BREAKING[ -]CHANGE: /m.test(message));
  const feature = messages.some(message => /^feat(?:\([^\r\n)]+\))?: /.test(message));
  const index = breaking ? 0 : feature ? 1 : 2;
  version[index] += 1n;
  for (let reset = index + 1; reset < 3; reset += 1) version[reset] = 0n;
  return `v${version.join('.')}`;
}

function planRelease(sha, runGit = git) {
  if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('RELEASE_SHA must be a full commit SHA');
  if (runGit('rev-parse', 'HEAD') !== sha) throw new Error('Checkout does not match the deployed commit');
  const tags = runGit('tag', '--list', 'v*')
    .split('\n')
    .filter(tag => VERSION.test(tag))
    .sort(compareVersions);
  // Estetika has no historical releases. Bootstrap only after a verified deployment.
  if (!tags.length) {
    return { sha, tag: INITIAL_VERSION, previousTag: undefined, existingTag: false, makeLatest: true };
  }
  const matching = tags.filter(tag => runGit('rev-parse', `refs/tags/${tag}^{commit}`) === sha);
  if (matching.length > 1) throw new Error('Multiple stable version tags point to the deployed commit');
  const existingTag = matching[0];
  const previousTag = existingTag ? tags[tags.indexOf(existingTag) - 1] : tags.at(-1);
  if (previousTag) {
    // Refuse to mint a new version for an old or divergent deployment.
    runGit('merge-base', '--is-ancestor', `refs/tags/${previousTag}`, sha);
  }
  const messages = existingTag
    ? []
    : runGit('log', '--format=%B%x00', `${previousTag}..${sha}`)
        .split('\0')
        .map(message => message.trim());
  const tag = existingTag || nextVersion(previousTag, messages);
  return {
    sha,
    tag,
    previousTag,
    existingTag: Boolean(existingTag),
    makeLatest: compareVersions(tag, tags.at(-1)) >= 0,
  };
}

function githubRequest(repository, token) {
  return async (method, route, body) => {
    const response = await fetch(`https://api.github.com/repos/${repository}${route}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      // Do not print credentials, response bodies, or generated notes in errors.
      const error = new Error(`GitHub ${method} ${route}: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
}

async function optional(request, route) {
  try {
    return await request('GET', route);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function tagCommit(request, tag) {
  const ref = await optional(request, `/git/ref/tags/${tag}`);
  if (!ref) return null;
  let object = ref.object;
  for (let depth = 0; object.type === 'tag' && depth < 10; depth += 1) {
    object = (await request('GET', `/git/tags/${object.sha}`)).object;
  }
  if (object.type !== 'commit') throw new Error(`${tag} does not resolve to a commit`);
  return object.sha;
}

async function publishRelease(plan, request, runUrl) {
  const { sha, tag, previousTag } = plan;
  const remoteSha = await tagCommit(request, tag);
  if (remoteSha && remoteSha !== sha) throw new Error(`${tag} already points to another commit; it will not be moved`);
  if (plan.existingTag && !remoteSha) throw new Error(`${tag} disappeared from GitHub; refusing to recreate it`);

  const existing = await optional(request, `/releases/tags/${tag}`);
  if (existing) {
    if (!remoteSha || existing.draft || existing.prerelease)
      throw new Error(`${tag} is not an existing stable release`);
    return { tag, url: existing.html_url, created: false };
  }

  const notes = await request('POST', '/releases/generate-notes', {
    tag_name: tag,
    target_commitish: sha,
    ...(previousTag ? { previous_tag_name: previousTag } : {}),
  });

  if (!remoteSha) {
    try {
      // Claim the exact commit before publishing. A partial failure can resume from this tag.
      await request('POST', '/git/refs', { ref: `refs/tags/${tag}`, sha });
    } catch (error) {
      if (error.status !== 422 || (await tagCommit(request, tag)) !== sha) throw error;
    }
  }
  // Never let the releases API silently use a tag moved by another writer.
  if ((await tagCommit(request, tag)) !== sha) throw new Error(`${tag} no longer matches the deployed commit`);
  const release = await request('POST', '/releases', {
    tag_name: tag,
    target_commitish: sha,
    name: tag,
    body: `Production deployment: ${runUrl}\n\nCommit: \`${sha}\`\n\n${notes.body}`,
    draft: false,
    prerelease: false,
    make_latest: plan.makeLatest ? 'true' : 'false',
  });
  return { tag, url: release.html_url, created: true };
}

async function main() {
  const plan = planRelease(process.env.RELEASE_SHA || process.env.GITHUB_SHA);
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Publication is only allowed in the production workflow on main');
  }
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !token || !/^\d+$/.test(process.env.GITHUB_RUN_ID || '')) {
    throw new Error('GitHub repository, token, and workflow run ID are required');
  }
  const runUrl = `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const result = await publishRelease(plan, githubRequest(repository, token), runUrl);
  const summary = `${result.created ? 'Published' : 'Already published'} [${result.tag}](${result.url}) for \`${plan.sha}\`.\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`publish-production-release: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { nextVersion, planRelease, publishRelease };
