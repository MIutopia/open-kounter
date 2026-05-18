import {
    consumeManagementToken,
    createStore,
    getEffectiveToken,
    jsonResponse,
    loadManagementToken,
    optionsResponse,
    RES_CODE
} from './_api.js'
import {
    deleteJson,
    loadSystemState,
    readJson,
    updateSystemState
} from './_blobStore.js'

const OIDC_SESSION_PREFIX = 'oidc/sessions/'

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
    const { action, token, newToken, managementToken, oidcSession } = body
    const state = await loadSystemState(store)
    const effectiveToken = await getEffectiveToken(store, env)

    if (action === 'get_status') {
      const hasOidcConfig = !!(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET && env.OIDC_REDIRECT_URI)
      const oidcBound = !!(state.oidc && state.oidc.sub)

      return jsonResponse(request, {
        code: RES_CODE.SUCCESS,
        data: {
          hasAdminToken: !!env.ADMIN_TOKEN,
          initialized: !!effectiveToken,
          // OIDC 登录按钮仅在配置完整且已绑定时显示
          oidcLoginEnabled: hasOidcConfig && oidcBound
        }
      })
    }

    if (!effectiveToken) {
      return jsonResponse(request, {
        code: RES_CODE.FAIL,
        message: 'Not initialized'
      })
    }

    // OIDC session 验证
    if (action === 'oidc_verify' && oidcSession) {
      const sessionKey = `${OIDC_SESSION_PREFIX}${oidcSession}.json`
      const sessionData = await readJson(store, sessionKey)

      if (!sessionData) {
        return jsonResponse(request, {
          code: RES_CODE.FAIL,
          message: 'Invalid or expired OIDC session'
        })
      }

      // 检查过期
      if (sessionData.expiresAt && sessionData.expiresAt <= Date.now()) {
        await deleteJson(store, sessionKey)
        return jsonResponse(request, {
          code: RES_CODE.FAIL,
          message: 'OIDC session expired'
        })
      }

      // 消费 session（一次性）
      await deleteJson(store, sessionKey)

      // 返回实际的 admin token，前端用它做后续鉴权
      return jsonResponse(request, {
        code: RES_CODE.SUCCESS,
        data: {
          authorized: true,
          token: sessionData.effectiveToken
        }
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
