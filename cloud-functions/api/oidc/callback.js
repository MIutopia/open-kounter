import {
    createStore,
    getEffectiveToken,
    validateTokenValue
} from '../_api.js'
import {
    deleteJson,
    loadSystemState,
    readJson,
    updateSystemState,
    writeJson
} from '../_blobStore.js'

const OIDC_STATE_PREFIX = 'oidc/states/'
const OIDC_SESSION_PREFIX = 'oidc/sessions/'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 天

/**
 * OIDC 回调处理
 * GET /api/oidc/callback?code=xxx&state=yyy
 */
export async function onRequestGet(context) {
  const { request, env } = context
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  // IDP 返回错误
  if (error) {
    const errorDesc = url.searchParams.get('error_description') || error
    return redirectToFrontend(env, `oidc_error=${encodeURIComponent(errorDesc)}`)
  }

  if (!code || !state) {
    return redirectToFrontend(env, 'oidc_error=missing_code_or_state')
  }

  const store = createStore(context)

  try {
    // 1. 验证并消费 state
    const stateKey = `${OIDC_STATE_PREFIX}${state}.json`
    const stateData = await readJson(store, stateKey)
    await deleteJson(store, stateKey)

    if (!stateData) {
      return redirectToFrontend(env, 'oidc_error=invalid_state')
    }

    if (stateData.expiresAt && stateData.expiresAt <= Date.now()) {
      return redirectToFrontend(env, 'oidc_error=state_expired')
    }

    // 2. 发现 OIDC 端点
    const endpoints = await discoverOIDCEndpoints(env.OIDC_ISSUER)

    // 3. 用 code 换取 token
    const tokenResponse = await fetch(endpoints.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: env.OIDC_REDIRECT_URI,
        client_id: env.OIDC_CLIENT_ID,
        client_secret: env.OIDC_CLIENT_SECRET
      }).toString()
    })

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text()
      console.error('Token exchange failed:', errText)
      return redirectToFrontend(env, 'oidc_error=token_exchange_failed')
    }

    const tokenData = await tokenResponse.json()

    // 4. 解析 id_token 获取用户信息
    let userInfo
    if (tokenData.id_token) {
      userInfo = decodeJWTPayload(tokenData.id_token)
    } else if (endpoints.userinfo_endpoint && tokenData.access_token) {
      // 如果没有 id_token（如 GitHub），用 access_token 获取 userinfo
      const userinfoRes = await fetch(endpoints.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      })
      if (userinfoRes.ok) {
        userInfo = await userinfoRes.json()
      }
    }

    if (!userInfo || !userInfo.sub) {
      return redirectToFrontend(env, 'oidc_error=no_user_info')
    }

    const { mode, token: bindToken } = stateData

    // 5. 根据模式处理
    if (mode === 'bind') {
      // 绑定模式：验证管理员 token，然后绑定 OIDC 身份
      try {
        await validateTokenValue(bindToken, store, env)
      } catch {
        return redirectToFrontend(env, 'oidc_error=invalid_admin_token')
      }

      // 将 OIDC 身份写入系统状态
      await updateSystemState(store, (current) => ({
        ...current,
        oidc: {
          sub: userInfo.sub,
          email: userInfo.email || '',
          name: userInfo.name || userInfo.preferred_username || '',
          issuer: env.OIDC_ISSUER,
          boundAt: Date.now()
        },
        updatedAt: Date.now()
      }))

      return redirectToFrontend(env, 'oidc_bound=true')
    } else {
      // 登录模式：验证 OIDC 身份是否已绑定
      const systemState = await loadSystemState(store)

      if (!systemState.oidc || !systemState.oidc.sub) {
        return redirectToFrontend(env, 'oidc_error=oidc_not_bound')
      }

      if (systemState.oidc.sub !== userInfo.sub) {
        return redirectToFrontend(env, 'oidc_error=identity_mismatch')
      }

      // 身份匹配，创建 session token
      const sessionId = generateUUID()
      const effectiveToken = await getEffectiveToken(store, env)

      await writeJson(store, `${OIDC_SESSION_PREFIX}${sessionId}.json`, {
        sessionId,
        sub: userInfo.sub,
        email: userInfo.email || '',
        effectiveToken,
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL_MS
      })

      return redirectToFrontend(env, `oidc_session=${sessionId}`)
    }
  } catch (err) {
    console.error('OIDC callback error:', err.message, err.stack)
    return redirectToFrontend(env, `oidc_error=${encodeURIComponent(err.message)}`)
  }
}

/**
 * 重定向回前端页面
 */
function redirectToFrontend(env, queryString) {
  // 从 OIDC_REDIRECT_URI 推导出前端地址
  const redirectUri = env.OIDC_REDIRECT_URI || ''
  const baseUrl = redirectUri.replace(/\/api\/oidc\/callback\/?$/, '')
  return Response.redirect(`${baseUrl}/?${queryString}`, 302)
}

/**
 * 发现 OIDC 端点配置
 */
async function discoverOIDCEndpoints(issuer) {
  const wellKnownUrl = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
  const res = await fetch(wellKnownUrl)
  if (!res.ok) {
    throw new Error(`Failed to fetch OIDC discovery document: ${res.status}`)
  }
  return await res.json()
}

/**
 * 解码 JWT payload（不验签，仅解析）
 * 注意：id_token 的签名验证依赖于 token 是通过安全的 server-to-server 通道获取的
 */
function decodeJWTPayload(jwt) {
  const parts = jwt.split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format')
  }
  const payload = parts[1]
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
  const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4))
  const jsonStr = atob(base64 + padding)
  return JSON.parse(jsonStr)
}

function generateUUID() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID().replace(/-/g, '')
  }
  return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/[x]/g, () => {
    return ((Math.random() * 16) | 0).toString(16)
  })
}

export default { onRequestGet }
