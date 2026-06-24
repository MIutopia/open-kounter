import { loadSystemState, normalizeSystemState, passkeyCredentialKey, passkeyChallengeKey, passkeyManagementTokenKey, passkeyUserKey, replaceAllCounterRecords, COUNTERS_DOC_KEY, deleteJson, saveSystemState, writeJson, withBlobLock } from './_blobStore.js'

const LEGACY_CHALLENGE_TTL_MS = 5 * 60 * 1000
const LEGACY_MANAGEMENT_TOKEN_TTL_MS = 5 * 60 * 1000

export async function migrateFromLegacy(request, env, store, token) {
  const bundle = await fetchLegacyBundle(request, token)
  return importLegacyBundle(store, env, bundle)
}

export async function fetchLegacyBundle(request, token) {
  const url = new URL(request.url)
  const response = await fetch(`${url.origin}/legacy-api/migrate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'export_all', token })
  })
  const rawBody = await response.text()
  let payload
  try { payload = JSON.parse(rawBody) }
  catch { throw new Error(rawBody || `Legacy migration request failed with status ${response.status}`) }
  if (payload.code !== 0) { throw new Error(payload.message || rawBody || 'Legacy migration failed') }
  return payload.data
}

export async function importLegacyBundle(store, env, bundle) {
  return withBlobLock(store, 'locks/legacy-migration.json', async () => {
    const counters = bundle?.counters && typeof bundle.counters === 'object' ? bundle.counters : {}
    const passkey = bundle?.passkey && typeof bundle.passkey === 'object' ? bundle.passkey : {}
    const users = passkey.users && typeof passkey.users === 'object' ? passkey.users : {}
    const credentials = passkey.credentials && typeof passkey.credentials === 'object' ? passkey.credentials : {}
    const challenges = passkey.challenges && typeof passkey.challenges === 'object' ? passkey.challenges : {}
    const managementTokens = passkey.managementTokens && typeof passkey.managementTokens === 'object' ? passkey.managementTokens : {}
    const now = Date.now()
    const currentState = await loadSystemState(store)
    const nextState = normalizeSystemState({
      ...currentState, token: env.ADMIN_TOKEN || bundle?.system?.token || currentState.token || null,
      allowedDomains: Array.isArray(bundle?.system?.allowedDomains) ? bundle.system.allowedDomains : [],
      initializedAt: currentState.initializedAt || now, updatedAt: now, version: '2.0'
    })
    await saveSystemState(store, nextState)
    await replaceAllCounterRecords(store, counters)
    await Promise.all(Object.entries(users).map(([userId, value]) => writeJson(store, passkeyUserKey(userId), value)))
    await Promise.all(Object.entries(credentials).map(([credentialId, value]) => writeJson(store, passkeyCredentialKey(credentialId), value)))
    return { migrated: true, importedCounters: Object.keys(counters).length }
  })
}