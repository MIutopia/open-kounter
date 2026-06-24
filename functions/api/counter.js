import {
  COUNTERS_DOC_KEY, deleteJson, deleteCounterRecord, getCounterRecord,
  listCounterRecords, loadSystemState, replaceAllCounterRecords,
  updateCountersDocument, updateCounterRecord, updateSystemState
} from './_blobStore.js'
import {
  createStore, failResponse, jsonResponse, optionsResponse,
  requireAuth, RES_CODE, successResponse
} from './_api.js'
import { importLegacyBundle, migrateFromLegacy } from './_legacyMigration.js'

export async function onRequest(context) {
  const { request, env } = context
  if (request.method === 'OPTIONS') return optionsResponse(request)
  const store = createStore(context)
  try {
    const url = new URL(request.url)
    if (request.method === 'GET') {
      const target = url.searchParams.get('target')
      if (!target) return failResponse(request, 'Missing target')
      const data = await getCounterRecord(store, target)
      return successResponse(request, { time: data ? data.time : 0, target, created_at: data ? data.created_at : 0, updated_at: data ? data.updated_at : 0 })
    }
    const body = await request.json()
    const { action, target, requests, value, legacyToken, legacyBundle } = body
    if (action === 'inc') {
      if (!target) throw new Error('Missing target')
      if (!await checkOriginAllowed(request, store)) throw new Error('Origin not allowed')
      const next = await updateCounterRecord(store, target, (current) => {
        const now = Date.now()
        return { target, time: (current?.time || 0) + 1, created_at: current?.created_at || now, updated_at: now }
      })
      return successResponse(request, { time: next.time, target })
    }
    if (action === 'batch_inc') {
      if (!Array.isArray(requests)) throw new Error('Invalid requests array')
      if (!await checkOriginAllowed(request, store)) throw new Error('Origin not allowed')
      const results = []
      const normalizedRequests = requests.map((item) => item.target || item.path || null)
      await updateCountersDocument(store, (current) => {
        const now = Date.now()
        const next = { ...current, items: { ...current.items }, updatedAt: now }
        for (const target of normalizedRequests) {
          if (!target) { results.push(null); continue }
          const record = next.items[target] || { target, time: 0, created_at: now, updated_at: now }
          const updated = { target, time: (record.time || 0) + 1, created_at: record.created_at || now, updated_at: now }
          next.items[target] = updated
          results.push({ target, time: updated.time })
        }
        return next
      })
      return successResponse(request, results)
    }
    if (target) {
      const data = await getCounterRecord(store, target)
      return successResponse(request, { time: data ? data.time : 0, target })
    }
    throw new Error('Unknown action')
  } catch (error) { return jsonResponse(request, { code: RES_CODE.FAIL, message: error.message }) }
}

async function checkOriginAllowed(request, store) {
  const origin = request.headers.get('origin')
  if (!origin) return true
  const state = await loadSystemState(store)
  const allowedDomains = state.allowedDomains
  if (!allowedDomains || allowedDomains.length === 0) return true
  for (const domain of allowedDomains) {
    if (domain === '*' || origin === domain) return true
    if (domain.startsWith('*.') && origin.endsWith(domain.slice(2))) return true
  }
  return false
}
export default { onRequest }