import { loadSystemState, updateSystemState } from './_blobStore.js'
import { createStore, jsonResponse, optionsResponse, RES_CODE, requireAuth } from './_api.js'
import { importLegacyBundle, migrateFromLegacy } from './_legacyMigration.js'

export async function onRequest(context) {
  const { request, env } = context
  if (request.method === 'OPTIONS') return optionsResponse(request)
  const store = createStore(context)
  try {
    if (request.method !== 'POST') throw new Error('Method not allowed')
    const body = await request.json()
    const { token, action, legacyToken, legacyBundle } = body
    const state = await loadSystemState(store)
    const isInitialized = !!(state.token || env.ADMIN_TOKEN)
    if (action === 'migrate_from_legacy') {
      if (isInitialized) await requireAuth(request, store, env)
      const migrationToken = legacyToken || token
      if (!migrationToken) throw new Error('Missing token')
      const result = legacyBundle ? await importLegacyBundle(store, env, legacyBundle) : await migrateFromLegacy(request, env, store, migrationToken)
      return jsonResponse(request, { code: RES_CODE.SUCCESS, data: result })
    }
    const initToken = env.ADMIN_TOKEN || token
    if (!initToken) throw new Error('Missing token')
    if (state.token) {
      if (env.ADMIN_TOKEN && state.token !== env.ADMIN_TOKEN) {
        await updateSystemState(store, (current) => ({ ...current, token: env.ADMIN_TOKEN, initializedAt: current.initializedAt || Date.now(), updatedAt: Date.now() }))
        return jsonResponse(request, { code: RES_CODE.SUCCESS, data: { message: 'Token synced with ADMIN_TOKEN' } })
      }
      return jsonResponse(request, { code: RES_CODE.FAIL, message: 'Already initialized' })
    }
    await updateSystemState(store, (current) => ({ ...current, token: initToken, initializedAt: current.initializedAt || Date.now(), updatedAt: Date.now() }))
    return jsonResponse(request, { code: RES_CODE.SUCCESS, data: { message: 'Initialized successfully' } })
  } catch (error) { return jsonResponse(request, { code: RES_CODE.FAIL, message: error.message }) }
}
export default { onRequest }