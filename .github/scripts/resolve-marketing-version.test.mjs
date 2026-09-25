import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bumpPatch,
  pushOverlayVersion,
  resolveOpenVersion,
} from './resolve-marketing-version.mjs'

test('keeps the current version when no train shipped it', () => {
  assert.equal(
    resolveOpenVersion('1.0.1', [{ state: 'PREPARE_FOR_SUBMISSION', versionString: '1.0.1' }]),
    '1.0.1',
  )
})

test('skips every released train', () => {
  const versions = [
    { state: 'REPLACED_WITH_NEW_VERSION', versionString: '1.0.0' },
    { state: 'READY_FOR_DISTRIBUTION', versionString: '1.0.1' },
    { state: 'READY_FOR_SALE', versionString: '1.0.2' },
  ]
  assert.equal(resolveOpenVersion('1.0.1', versions), '1.0.3')
})

test('skips trains approved but not yet released', () => {
  for (const state of ['ACCEPTED', 'PENDING_DEVELOPER_RELEASE', 'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_DISTRIBUTION']) {
    assert.equal(resolveOpenVersion('1.0.2', [{ state, versionString: '1.0.2' }]), '1.0.3', state)
  }
})

test('builds above a released train when the current version was skipped', () => {
  const versions = [
    { state: 'READY_FOR_DISTRIBUTION', versionString: '1.0.3' },
    { state: 'READY_FOR_DISTRIBUTION', versionString: '1.0.1' },
  ]
  assert.equal(resolveOpenVersion('1.0.2', versions), '1.0.4')
})

test('keeps a current version already above every closed train', () => {
  assert.equal(
    resolveOpenVersion('1.1.0', [{ state: 'READY_FOR_DISTRIBUTION', versionString: '1.0.9' }]),
    '1.1.0',
  )
})

test('treats unknown states as open', () => {
  assert.equal(
    resolveOpenVersion('1.0.1', [{ state: 'SOME_FUTURE_STATE', versionString: '1.0.1' }]),
    '1.0.1',
  )
})

test('rejects versions that are not three parts', () => {
  assert.throws(() => bumpPatch('1.0'), /three-part/)
})

test('pushes a skip-ci commit that only changes the version', async () => {
  const overlay = { bundleId: 'in.innei', scheme: 'yohaku', version: '1.0.1' }
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ init, url: String(url) })
    if (init.method === 'PUT') return { json: async () => ({}), ok: true, status: 200 }
    return {
      json: async () => ({
        content: Buffer.from(JSON.stringify(overlay)).toString('base64'),
        sha: 'blob-sha',
      }),
      ok: true,
      status: 200,
    }
  }

  const pushed = await pushOverlayVersion({
    fetchImpl,
    path: 'apps/mobile-overlay/expo.json',
    repo: 'innei-dev/yohaku',
    token: 'token',
    version: '1.0.2',
  })

  assert.equal(pushed, true)
  const put = JSON.parse(calls.at(-1).init.body)
  assert.equal(put.sha, 'blob-sha')
  assert.match(put.message, /\[skip ci\]$/)
  assert.deepEqual(JSON.parse(Buffer.from(put.content, 'base64').toString('utf8')), {
    ...overlay,
    version: '1.0.2',
  })
})

test('does not push when main already carries the version', async () => {
  const fetchImpl = async () => ({
    json: async () => ({
      content: Buffer.from(JSON.stringify({ version: '1.0.2' })).toString('base64'),
      sha: 'blob-sha',
    }),
    ok: true,
    status: 200,
  })

  assert.equal(
    await pushOverlayVersion({
      fetchImpl,
      path: 'apps/mobile-overlay/expo.json',
      repo: 'innei-dev/yohaku',
      token: 'token',
      version: '1.0.2',
    }),
    false,
  )
})
