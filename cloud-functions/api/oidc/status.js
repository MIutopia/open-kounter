import {
    createStore,
    jsonResponse,
    optionsResponse,
    requireAuth,
    RES_CODE
} from '../_api.js'
import { loadSystemState, updateSystemState } from '../_blobStore.js'

/**
 * OIDC 状态查询与管理
 * POST /api/oidc/status
 *   action: 'get_status' — 查询 OIDC 配置和绑定状态（无需鉴权）
 *   action: 'unbind' — 解绑 OIDC 身份（需要鉴权）
 */
export async function onRequest(context) {
  const { request, env } = context

  if (request.method === 'OPTIONS') {
    return optionsResponse(request)
  }

  if (request.method !== 'POST') {
    return jsonResponse(request, { code: RES_CODE.FAIL, message: 'Method not allowed' })
  }

  const store = createStore(context)

  try {
    const body = await request.json()
    const { action } = body

    if (action === 'get_status') {
      // 查询 OIDC 配置和绑定状态（无需鉴权）
      const hasOidcConfig = !!(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET && env.OIDC_REDIRECT_URI)
      const state = await loadSystemState(store)
      const oidcBound = !!(state.oidc && state.oidc.sub)

      return jsonResponse(request, {
        code: RES_CODE.SUCCESS,
        data: {
          configured: hasOidcConfig,
          bound: oidcBound,
          // 仅在已绑定时返回脱敏信息
          ...(oidcBound ? {
            email: maskEmail(state.oidc.email),
            name: state.oidc.name || '',
            boundAt: state.oidc.boundAt
          } : {})
        }
      })
    }

    if (action === 'unbind') {
      // 解绑 OIDC 身份（需要鉴权）
      await requireAuth(request, store, env)

      await updateSystemState(store, (current) => {
        const next = { ...current, updatedAt: Date.now() }
        delete next.oidc
        return next
      })

      return jsonResponse(request, {
        code: RES_CODE.SUCCESS,
        message: 'OIDC identity unbound'
      })
    }

    return jsonResponse(request, { code: RES_CODE.FAIL, message: 'Unknown action' })
  } catch (error) {
    return jsonResponse(request, {
      code: RES_CODE.FAIL,
      message: error.message
    })
  }
}

/**
 * 邮箱脱敏
 */
function maskEmail(email) {
  if (!email) return ''
  const [local, domain] = email.split('@')
  if (!domain) return email
  if (local.length <= 2) return `${local[0]}***@${domain}`
  return `${local[0]}${local[1]}***@${domain}`
}

export default { onRequest }
