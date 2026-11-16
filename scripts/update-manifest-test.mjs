#!/usr/bin/env node
// Offline test for the skill-aware update probe. A local git daemon serves a
// fixture repository so the real git:// transport, ls-remote, and tree:0 fetch
// paths all run for real without touching the network.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-skill-upd-'))
process.env.DSH_HOME = home
const { createManager } = await import('../lib/manager.js')
const { loadState } = await import('../lib/state.js')

function git(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) }).toString()
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
}
function commit(dir, message) {
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', message])
  return git(dir, ['rev-parse', 'HEAD']).trim()
}
function skillText(name, description) {
  return '---\nname: ' + name + '\ndescription: ' + description + '\n---\n\n# ' + name + '\n'
}
async function startDaemon(root) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = 9500 + Math.floor(Math.random() * 400)
    const child = spawn('git', ['daemon', '--reuseaddr', '--export-all', '--enable=upload-pack', '--listen=127.0.0.1', '--port=' + String(port), '--base-path=' + root, root], { stdio: 'ignore', windowsHide: true })
    const url = 'git://127.0.0.1:' + String(port) + '/'
    for (let i = 0; i < 20; i += 1) {
      await new Promise(function (resolve) { setTimeout(resolve, 150) })
      try {
        execFileSync('git', ['ls-remote', url + 'source-repo.git', 'HEAD'], { stdio: 'pipe', env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) })
        return { url: url, stop: function () { try { child.kill() } catch (error) {} } }
      } catch (error) { if (child.exitCode !== null) break }
    }
    try { child.kill() } catch (error) {}
  }
  throw new Error('无法启动本地 git daemon')
}

const serve = path.join(home, 'serve')
fs.mkdirSync(serve, { recursive: true })
const bare = path.join(serve, 'source-repo.git')
const source = path.join(home, 'source-repo')
initRepo(source)
git(home, ['init', '-q', '--bare', '-b', 'main', bare])
git(bare, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
git(bare, ['config', 'uploadpack.allowFilter', 'true'])
git(source, ['remote', 'add', 'origin', bare])

function publish(dir, message) {
  const sha = commit(dir, message)
  git(dir, ['push', '-q', '-f', 'origin', 'HEAD:main'])
  return sha
}

write(path.join(source, 'skills', 'alpha', 'SKILL.md'), skillText('alpha', 'Alpha skill'))
write(path.join(source, 'skills', 'alpha', 'references', 'ref.md'), 'reference v1\n')
write(path.join(source, 'README.md'), 'readme v1\n')
const c1 = publish(source, 'C1 skills')

const daemon = await startDaemon(serve)
const repoUrl = daemon.url + 'source-repo.git'

const manager = createManager(null, {})
await manager.ready

const scan = await manager.scanSource({ url: repoUrl, subdir: 'skills' })
assert.equal(scan.ok, true)
assert.equal(scan.source.kind, 'git')
assert.deepEqual(scan.skills.map(function (s) { return s.relPath }), ['skills/alpha'])
const imported = await manager.commitImport({ scanId: scan.scanId, skills: [{ relPath: 'skills/alpha', name: 'alpha' }] })
assert.deepEqual(imported.installed, ['alpha'])

let state = loadState()
let repo = state.repos[0]
assert.ok(repo.manifest, 'import must record a manifest')
assert.equal(repo.manifest.commit, c1)
assert.ok(repo.manifest.trees['skills/alpha'], 'alpha tree id missing')
const repoId = repo.id

// 1) Commit that touches only README: no skill update.
write(path.join(source, 'README.md'), 'readme v2\n')
const c2 = publish(source, 'C2 readme only')
let result = await manager.checkUpdates()
assert.equal(result.updates, 0, 'README-only commit must not count as a skill update')
state = loadState(); repo = state.repos[0]
assert.equal(repo.latestCommit, c2)
assert.equal(repo.skillUpdate, false)
assert.equal(manager.views().repos[0].updateAvailable, false)

// 2) Baseline manifest lost (legacy install): rebuild silently, no false prompt.
const legacy = loadState()
legacy.repos[0].manifest = null
legacy.repos[0].latestCommit = null
legacy.repos[0].skillUpdate = null
fs.writeFileSync(path.join(home, 'dsh-skills-tools', 'state.json'), JSON.stringify(legacy, null, 2))
result = await manager.checkUpdates()
assert.equal(result.updates, 0, 'legacy baseline rebuild must not raise a false update')
state = loadState(); repo = state.repos[0]
assert.ok(repo.manifest && repo.manifest.commit === c1, 'baseline manifest must be learned from repo.commit')

// 3) Reference file under the skill directory changes: update.
write(path.join(source, 'skills', 'alpha', 'references', 'ref.md'), 'reference v2\n')
const c3 = publish(source, 'C3 reference change')
result = await manager.checkUpdates()
assert.equal(result.updates, 1, 'reference change must count as a skill update')
assert.equal(manager.views().repos[0].updateAvailable, true)

await manager.updateRepo(repoId)
state = loadState(); repo = state.repos[0]
assert.equal(repo.commit, c3)
assert.equal(repo.skillUpdate, false)
assert.equal(manager.views().repos[0].updateAvailable, false)
assert.equal(repo.manifest.commit, c3)

// 4) New SKILL.md inside the monitored subdirectory: update.
write(path.join(source, 'skills', 'beta', 'SKILL.md'), skillText('beta', 'Beta skill'))
const c4 = publish(source, 'C4 new skill')
result = await manager.checkUpdates()
assert.equal(result.updates, 1, 'a new skill dir under the subdir must count')
await manager.updateRepo(repoId)
assert.equal(loadState().repos[0].commit, c4)

// 5) Removal of a skill directory: update.
git(source, ['rm', '-r', '-q', 'skills/beta'])
const c5 = publish(source, 'C5 drop skill')
result = await manager.checkUpdates()
assert.equal(result.updates, 1, 'removed skill must count')
await manager.updateRepo(repoId)

// 6) No-subdir repository monitors only the imported skill directories.
const flat = path.join(home, 'flat-repo')
const flatBare = path.join(serve, 'flat-repo.git')
initRepo(flat)
git(home, ['init', '-q', '--bare', '-b', 'main', flatBare])
git(flatBare, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
git(flatBare, ['config', 'uploadpack.allowFilter', 'true'])
git(flat, ['remote', 'add', 'origin', flatBare])
write(path.join(flat, 'pkg', 'tool', 'SKILL.md'), skillText('tool', 'Tool skill'))
write(path.join(flat, 'docs', 'readme.md'), 'docs v1\n')
const f1 = commit(flat, 'F1 skill')
git(flat, ['push', '-q', '-f', 'origin', 'HEAD:main'])
const flatUrl = daemon.url + 'flat-repo.git'
const flatScan = await manager.scanSource({ url: flatUrl })
assert.equal(flatScan.ok, true)
const flatImport = await manager.commitImport({ scanId: flatScan.scanId, skills: [{ relPath: 'pkg/tool', name: 'tool' }] })
assert.deepEqual(flatImport.installed, ['tool'])
const flatRepo = loadState().repos.find(function (r) { return r.url === flatUrl })
assert.ok(flatRepo && flatRepo.manifest, 'flat repo manifest missing')
assert.deepEqual(Object.keys(flatRepo.manifest.trees), ['pkg/tool'])

write(path.join(flat, 'docs', 'readme.md'), 'docs v2\n')
const f2 = commit(flat, 'F2 docs only')
git(flat, ['push', '-q', '-f', 'origin', 'HEAD:main'])
result = await manager.checkUpdates()
assert.equal(result.updates, 0, 'docs-only commit in a flat repo must not count')
assert.equal(loadState().repos.find(function (r) { return r.url === flatUrl }).latestCommit, f2)

write(path.join(flat, 'pkg', 'tool', 'references.md'), 'ref\n')
const f3 = commit(flat, 'F3 skill reference')
git(flat, ['push', '-q', '-f', 'origin', 'HEAD:main'])
result = await manager.checkUpdates()
assert.equal(result.updates, 1, 'new file inside the imported skill dir must count')
assert.equal(loadState().repos.find(function (r) { return r.url === flatUrl }).latestCommit, f3)
assert.equal(loadState().repos.find(function (r) { return r.url === flatUrl }).commit, f1)

await manager.dispose()
daemon.stop()
await fsp.rm(home, { recursive: true, force: true })
console.log('all update-manifest checks passed')
