#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync, chmodSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const NAME = 'Thot Market';
const EMAIL = 'release@thot.market';
const IDENTITY = `${NAME} <${EMAIL}>`;
const VERSION_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.[1-9]\d*)?$/;
const HOOK = `#!/bin/sh
set -eu
repo=$(git rev-parse --show-toplevel)
exec node "$repo/scripts/check-release-git-identity.mjs" --hook
`;

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', env: {...process.env, GIT_NO_REPLACE_OBJECTS: '1'}, stdio: ['ignore', 'pipe', 'pipe']}).trimEnd();
}
function need(ok, message) {if (!ok) throw Error(message);}
function local(root, key) {
  try {return git(root, ['config', '--local', '--get', key]);}
  catch {return null;}
}
function effective(root, key) {
  try {return git(root, ['config', '--get', key]);}
  catch {return null;}
}
function checkLocal(root) {
  need(local(root, 'user.name') === NAME && local(root, 'user.email') === EMAIL,
    'PROJECT_LOCAL_GIT_IDENTITY_REQUIRED');
  need(local(root, 'user.useConfigOnly') === 'true', 'PROJECT_GIT_CONFIG_ONLY_REQUIRED');
  need(!effective(root, 'core.hooksPath'), 'CUSTOM_HOOKS_PATH_NOT_REVIEWED');
  need(local(root, 'commit.gpgsign') === 'false' && local(root, 'tag.gpgsign') === 'false',
    'PROJECT_SIGNING_CONFIGURATION_NOT_REVIEWED');
  const hook = resolve(root, git(root, ['rev-parse', '--git-path', 'hooks/pre-push']));
  need(existsSync(hook) && readFileSync(hook, 'utf8') === HOOK,
    'RELEASE_PRE_PUSH_HOOK_REQUIRED');
  need((statSync(hook).mode & 0o111) !== 0, 'RELEASE_PRE_PUSH_HOOK_NOT_EXECUTABLE');
}

export function installReleaseGitIdentity(root) {
  root = resolve(root);
  need(git(root, ['rev-parse', '--is-inside-work-tree']) === 'true', 'NOT_A_GIT_WORKTREE');
  need(!effective(root, 'core.hooksPath'), 'CUSTOM_HOOKS_PATH_NOT_REVIEWED');
  const hook = resolve(root, git(root, ['rev-parse', '--git-path', 'hooks/pre-push']));
  need(!existsSync(hook) || readFileSync(hook, 'utf8') === HOOK,
    'EXISTING_PRE_PUSH_HOOK_REQUIRES_REVIEW');
  for (const [key, value] of [
    ['user.name', NAME], ['user.email', EMAIL], ['user.useConfigOnly', 'true'],
    ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'],
  ]) git(root, ['config', '--local', key, value]);
  if (!existsSync(hook)) writeFileSync(hook, HOOK, {flag: 'wx', mode: 0o755});
  chmodSync(hook, 0o755);
  checkLocal(root);
  return {identity: IDENTITY, hook: 'installed'};
}

function checkMessage(message, tag) {
  const match = /^Release (v[^\s]+)\n?$/.exec(message);
  need(match && VERSION_TAG.test(match[1]) && (!tag || match[1] === tag), 'NEUTRAL_RELEASE_MESSAGE_REQUIRED');
}
function inspectObject(root, oid, expectedType) {
  need(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid), 'INVALID_RELEASE_OBJECT');
  const type = git(root, ['cat-file', '-t', oid]);
  need(type === expectedType, 'UNEXPECTED_RELEASE_OBJECT_TYPE');
  const raw = git(root, ['cat-file', '-p', oid]), split = raw.indexOf('\n\n');
  need(split >= 0, 'RELEASE_MESSAGE_REQUIRED');
  const headers = raw.slice(0, split).split('\n');
  for (const field of type === 'commit' ? ['author', 'committer'] : ['tagger']) {
    const lines = headers.filter(line => line.startsWith(field + ' '));
    const prefix = field + ' ' + IDENTITY + ' ';
    need(lines.length === 1 && lines[0].startsWith(prefix) && /^[0-9]+ [+-][0-9]{4}$/.test(lines[0].slice(prefix.length)),
      `UNREVIEWED_${field.toUpperCase()}:${oid}`);
  }
  const permitted = type === 'commit' ? /^(tree|parent|author|committer) / : /^(object|type|tag|tagger) /;
  need(headers.every(line => permitted.test(line)), 'UNREVIEWED_RELEASE_HEADER');
  if (type === 'tag') {
    const tag = headers.find(line => line.startsWith('tag '))?.slice(4);
    need(VERSION_TAG.test(tag ?? '') && headers.includes('type commit'), 'INVALID_RELEASE_TAG_OBJECT');
    checkMessage(raw.slice(split + 2), tag);
    return {tag, target: headers.find(line => line.startsWith('object '))?.slice(7)};
  }
  checkMessage(raw.slice(split + 2));
  return {parents: headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7))};
}

export function checkReleaseGitIdentity({root, tag, all = false, prePush = false, pushInput}) {
  root = resolve(root);
  need(Number(all) + Number(prePush) + Number(Boolean(tag)) === 1, 'CHOOSE_ONE_IDENTITY_AUDIT_MODE');
  need(git(root, ['rev-parse', '--is-inside-work-tree']) === 'true', 'NOT_A_GIT_WORKTREE');
  need(git(root, ['rev-parse', '--is-shallow-repository']) === 'false', 'FULL_RELEASE_HISTORY_REQUIRED');
  if (prePush) checkLocal(root);
  if (tag) need(VERSION_TAG.test(tag), 'INVALID_RELEASE_TAG');
  const refs = all || prePush
    ? git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags']).split('\n').filter(Boolean)
    : [`refs/tags/${tag}`];
  const targets = refs.map(ref => ({ref, oid: git(root, ['rev-parse', '--verify', ref])}));
  // Git supplies actual outgoing object IDs on stdin, including detached HEAD
  // and explicit SHA refspecs that are not reachable from any local branch/tag.
  if (pushInput !== undefined) {
    need(prePush && typeof pushInput === 'string', 'INVALID_PUSH_INPUT');
    for (const line of pushInput.trim().split('\n').filter(Boolean)) {
      const fields = line.split(/\s+/);
      need(fields.length === 4, 'INVALID_PUSH_UPDATE');
      const [, oid, ref] = fields;
      need(!/^0+$/.test(oid), 'RELEASE_REF_DELETION_REQUIRES_REVIEW');
      need(ref === 'refs/heads/main' || ref.startsWith('refs/tags/') && VERSION_TAG.test(ref.slice(10)), 'UNREVIEWED_PUSH_REF');
      targets.push({ref, oid});
    }
  }
  need(targets.length > 0, 'NO_RELEASE_REFS');
  const commits = new Set(), tags = new Set(), pending = [];
  for (const {ref, oid} of targets) {
    if (ref.startsWith('refs/tags/')) {
      need(git(root, ['cat-file', '-t', oid]) === 'tag', 'ANNOTATED_TAG_REQUIRED');
      const value = inspectObject(root, oid, 'tag');
      need(ref === 'refs/tags/' + value.tag, 'TAG_REF_NAME_MISMATCH');
      tags.add(oid); pending.push(value.target);
    } else pending.push(oid);
  }
  // Follow raw parent headers; replacement refs and shallow traversal must not
  // conceal metadata in objects which can be transmitted to the destination.
  while (pending.length) {
    const oid = pending.pop();
    if (commits.has(oid)) continue;
    const value = inspectObject(root, oid, 'commit');
    commits.add(oid); pending.push(...value.parents);
  }
  need(commits.size > 0, 'NO_RELEASE_COMMITS');
  return {commits: commits.size, tags: tags.size};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, value] = process.argv.slice(2);
  const root = process.cwd();
  if (mode === '--install' && !value) console.log(JSON.stringify(installReleaseGitIdentity(root)));
  else if (mode === '--all' && !value) console.log(JSON.stringify(checkReleaseGitIdentity({root, all: true})));
  else if (mode === '--pre-push' && !value) console.log(JSON.stringify(checkReleaseGitIdentity({root, prePush: true})));
  else if (mode === '--hook' && !value) console.log(JSON.stringify(checkReleaseGitIdentity({root, prePush: true, pushInput: readFileSync(0, 'utf8')})));
  else if (mode === '--tag' && value && process.argv.length === 4)
    console.log(JSON.stringify(checkReleaseGitIdentity({root, tag: value})));
  else throw Error('Usage: check-release-git-identity.mjs --install | --pre-push | --all | --tag VERSION');
}
