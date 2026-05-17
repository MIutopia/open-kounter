import {
  deleteJson,
  loadSystemState,
  updateSystemState
} from './_blobStore.js'
import {
  consumeManagementToken,
  createStore,
  getEffectiveToken,
  jsonResponse,
  loadManagementToken,
  optionsResponse,
  RES_CODE
} from './_api.js'

export async function onRequest(context) {
  const { request, env } = context

  if (request.method === 'OPTIONS') {
    return optionsResponse(request)
  }

  const store = createStore(context)

  try {
    if (request.method !== 'POST') {
      throw new Error('Method not allowed')
    }

    const body = await request.json()
    const { action, token, newToken, managementToken } = body
    const state = await loadSystemState(store)
    const effectiveToken = await getEffectiveToken(store, env)

    if (action === 'get_status') {
      return jsonResponse(request, {
        code: RES_CODE.SUCCESS,
        data: {
          hasAdminToken: !!env.ADMIN_TOKEN,
          initialized: !!effectiveToken
        }
      })
    }

    if (!effectiveToken) {
      return jsonResponse(request, {
        code: RES_CODE.FAIL,
        message: 'Not initialized'
      })
    }

    if (action === 'syncAdminToken') {
      if (!env.ADMIN_TOKEN) {
        return jsonResponse(request, {
          code: RES_CODE.FAIL,
          message: 'ADMIN_TOKEN not configured'
        })
      }

      if (!token || token !== env.ADMIN_TOKEN) {
        return jsonResponse(request, {
          code: RES_CODE.FAIL,
          message: 'Invalid ADMIN_TOKEN'
        })
      }

      await updateSystemState(store, (current) => ({
        ...current,
        token: env.ADMIN_TOKEN,
        initializedAt: current.initializedAt || Date.now(),
        updatedAt: Date.now()
      }))

      return jsonResponse(request, {
        code: RES_CODE.SUCCESS,
        message: 'Blob token synced with ADMIN_TOKEN'
      })
    }

    let authorized = false
    let managementTokenId = null

    if (token && (token === effectiveToken || (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN))) {
      authorized = true
    } else if (managementToken) {
      const managementData = await loadManagementToken(store, managementToken)
      if (managementData) {
        authorized = true
        managementTokenId = managementToken
      }
    }

    if (!authorized) {
      return jsonResponse(request, {
        code: RES_CODE.FAIL,
        message: 'Invalid token or unauthorized'
      })
    }

    if (newToken) {
      await updateSystemState(store, (current) => ({
        ...current,
        token: newToken,
        initializedAt: current.initializedAt || Date.now(),
        updatedAt: Date.now()
      }))

      if (managementTokenId) {
        await consumeManagementToken(store, managementTokenId)
      }

      return jsonResponse(request, {
        code: RES_CODE.SUCCESS,
        message: 'Token updated'
      })
    }

    return jsonResponse(request, {
      code: RES_CODE.SUCCESS,
      data: {
        authorized: true,
        initialized: !!state.token || !!env.ADMIN_TOKEN
      }
    })
  } catch (error) {
    return jsonResponse(request, {
      code: RES_CODE.FAIL,
      message: error.message
    })
  }
}

export default { onRequest }