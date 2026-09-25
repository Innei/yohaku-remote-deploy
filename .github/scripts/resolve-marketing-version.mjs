import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

import { createAppStoreClient } from './wait-for-app-store-build.mjs'

const GITHUB_API_ORIGIN = 'https://api.github.com'

// Apple rejects new builds for a train once review approves its version, even
// before release. Every other state (including unknown future ones) still
// accepts uploads, so an unrecognised state must never trigger a bump.
const CLOSED_VERSION_STATES = new Set([
  'ACCEPTED',
  'DEVELOPER_REMOVED_FROM_SALE',
  'PENDING_APPLE_RELEASE',
  'PENDING_DEVELOPER_RELEASE',
  'PREORDER_READY_FOR_SALE',
  'PROCESSING_FOR_APP_STORE',
  'PROCESSING_FOR_DISTRIBUTION',
  'READY_FOR_DISTRIBUTION',
  'READY_FOR_SALE',
  'REMOVED_FROM_SALE',
  'REPLACED_WITH_NEW_VERSION',
])

export function bumpPatch(version) {
  const parts = version.split('.').map(Number)
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`Not a three-part version: ${version}`)
  }
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`
}

export function resolveOpenVersion(currentVersion, versions) {
  const closed = new Set(
    versions
      .filter((version) => CLOSED_VERSION_STATES.has(version.state))
      .map((version) => version.versionString),
  )

  let candidate = currentVersion
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!closed.has(candidate)) return candidate
    candidate = bumpPatch(candidate)
  }
  throw new Error(`Could not find an open App Store train above ${currentVersion}`)
}

export async function readAppStoreVersions({ bundleId, client }) {
  const apps = await client.get(
    `/v1/apps?${new URLSearchParams({ 'filter[bundleId]': bundleId, limit: '1' })}`,
  )
  const app = apps.data?.[0]
  if (!app) throw new Error(`No App Store Connect app found for bundle ${bundleId}`)

  const document = await client.get(
    `/v1/apps/${app.id}/appStoreVersions?${new URLSearchParams({
      'filter[platform]': 'IOS',
      limit: '200',
    })}`,
  )

  return (document.data ?? []).map((version) => ({
    state: version.attributes?.appVersionState ?? version.attributes?.appStoreState,
    versionString: version.attributes?.versionString,
  }))
}

export function writeOverlayVersion(file, version) {
  const overlay = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (overlay.version === version) return false
  overlay.version = version
  fs.writeFileSync(file, `${JSON.stringify(overlay, null, 2)}\n`)
  return true
}

export async function pushOverlayVersion({
  branch = 'main',
  fetchImpl = fetch,
  path,
  repo,
  token,
  version,
}) {
  const url = `${GITHUB_API_ORIGIN}/repos/${repo}/contents/${path}`
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }

  const request = async (target, init) => {
    const response = await fetchImpl(target, { ...init, headers, signal: AbortSignal.timeout(30_000) })
    const body = await response.json()
    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status}: ${JSON.stringify(body)}`)
    }
    return body
  }

  const current = await request(`${url}?ref=${branch}`)
  const overlay = JSON.parse(Buffer.from(current.content, 'base64').toString('utf8'))
  if (overlay.version === version) return false

  overlay.version = version
  await request(url, {
    body: JSON.stringify({
      branch,
      content: Buffer.from(`${JSON.stringify(overlay, null, 2)}\n`).toString('base64'),
      // Without the skip marker this push would dispatch another ship run.
      message: `chore(mobile): bump app version to ${version} [skip ci]`,
      sha: current.sha,
    }),
    method: 'PUT',
  })
  return true
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function main() {
  const client = createAppStoreClient({
    issuerId: requiredEnvironment('ASC_ISSUER_ID'),
    keyId: requiredEnvironment('ASC_KEY_ID'),
    privateKey: requiredEnvironment('ASC_API_KEY_P8'),
  })

  const currentVersion = requiredEnvironment('MARKETING_VERSION')
  const versions = await readAppStoreVersions({
    bundleId: requiredEnvironment('APP_BUNDLE_ID'),
    client,
  })
  const resolved = resolveOpenVersion(currentVersion, versions)

  if (resolved === currentVersion) {
    console.log(`App Store train ${currentVersion} still accepts builds`)
    return
  }

  const overlayPath = requiredEnvironment('OVERLAY_EXPO_PATH')
  writeOverlayVersion(`${requiredEnvironment('GITHUB_WORKSPACE')}/${overlayPath}`, resolved)
  const pushed = await pushOverlayVersion({
    path: overlayPath,
    repo: requiredEnvironment('APP_REPO_SLUG'),
    token: requiredEnvironment('GH_TOKEN'),
    version: resolved,
  })

  console.log(
    `App Store train ${currentVersion} is closed; building ${resolved} ` +
      `(${pushed ? 'committed to' : 'already on'} main)`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
