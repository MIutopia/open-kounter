import {
  deleteJson,
  loadSystemState,
  passkeyChallengeKey,
  passkeyCredentialKey,
  passkeyManagementTokenKey,
  passkeyUserKey,
  passkeyUserLockKey,
  readJson,
  withBlobLock,
  writeJson
} from './_blobStore.js'
import {
  createStore,
  jsonResponse,
  optionsResponse,
  RES_CODE
} from './_api.js'

const VERSION = '2.0.0'
const TRANSIENT_TTL_MS = 5 * 60 * 1000

function getRPConfig(request, env) {
  const url = new URL(request.url)
  const origin = resolveRequestOrigin(request, url)
  const originUrl = tryParseUrl(origin)
  const requestHost = request.headers.get('host') || url.host
  const rpID = normalizeRpId(
    env?.PASSKEY_RP_ID
      || env?.WEBAUTHN_RP_ID
      || originUrl?.hostname
      || requestHost
      || url.hostname
  )

  return {
    rpName: env?.PASSKEY_RP_NAME || 'Open Kounter',
    rpID,
    origin
  }
}

export async function onRequest(context) {
  const { request, env } = context

  if (request.method === 'OPTIONS') {
    return optionsResponse(request)
  }

  if (request.method !== 'POST') {
    return jsonResponse(request, {
      code: RES_CODE.SUCCESS,
      message: 'Open Kounter Passkey API',
      version: VERSION
    })
  }

  const store = createStore(context)
  const rpConfig = getRPConfig(request, env)

  try {
    const body = await request.json()
    const { action, data } = body

    let result
    switch (action) {
      case 'generateRegistrationOptions':
        result = await handleGenerateRegistrationOptions(store, data, rpConfig, env)
        break
      case 'verifyRegistration':
        result = await handleVerifyRegistration(store, data, rpConfig)
        break
      case 'generateAuthenticationOptions':
        result = await handleGenerateAuthenticationOptions(store, data, rpConfig)
        break
      case 'verifyAuthentication':
        result = await handleVerifyAuthentication(store, data, rpConfig)
        break
      case 'generateManagementToken':
        result = await handleGenerateManagementToken(store, data, rpConfig)
        break
      case 'listCredentials':
        result = await handleListCredentials(store, data)
        break
      case 'deleteCredential':
        result = await handleDeleteCredential(store, data)
        break
      case 'cancelChallenge':
        result = await handleCancelChallenge(store, data)
        break
      default:
        result = { code: RES_CODE.FAIL, message: 'Unknown action' }
    }

    return jsonResponse(request, result)
  } catch (error) {
    console.error('Passkey error:', error.message, error.stack)
    return jsonResponse(request, {
      code: RES_CODE.FAIL,
      message: `Passkey Error: ${error.message}`
    })
  }
}

function resolveRequestOrigin(request, url) {
  const originHeader = request.headers.get('origin')
  if (originHeader && originHeader !== 'null') {
    return originHeader
  }

  const refererHeader = request.headers.get('referer')
  const refererUrl = tryParseUrl(refererHeader)
  if (refererUrl) {
    return refererUrl.origin
  }

  return `${url.protocol}//${url.host}`
}

function tryParseUrl(value) {
  if (!value) {
    return null
  }

  try {
    return new URL(value)
  } catch {
    return null
  }
}

function normalizeRpId(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) {
    return 'localhost'
  }

  if (normalized === 'localhost') {
    return normalized
  }

  return normalized.replace(/:\d+$/, '')
}

async function getUser(store, userId) {
  return await readJson(store, passkeyUserKey(userId))
}

async function saveUser(store, user) {
  await writeJson(store, passkeyUserKey(user.id), user)
}

async function updateUser(store, userId, updater) {
  return withBlobLock(store, passkeyUserLockKey(userId), async () => {
    const current = await getUser(store, userId)
    const next = await updater(current)
    if (next) {
      await saveUser(store, next)
    }
    return next
  })
}

async function getCredential(store, credentialId) {
  return await readJson(store, passkeyCredentialKey(credentialId))
}

async function saveCredential(store, credential) {
  await writeJson(store, passkeyCredentialKey(credential.id), credential)
  await updateUser(store, credential.userId, (user) => {
    if (!user) {
      return null
    }
    const credentialIds = Array.isArray(user.credentialIds) ? user.credentialIds : []
    if (!credentialIds.includes(credential.id)) {
      credentialIds.push(credential.id)
    }
    return {
      ...user,
      credentialIds
    }
  })
}

async function getUserCredentials(store, userId) {
  const user = await getUser(store, userId)
  if (!user || !Array.isArray(user.credentialIds)) {
    return []
  }

  const credentials = await Promise.all(user.credentialIds.map((credentialId) => getCredential(store, credentialId)))
  return credentials.filter(Boolean)
}

async function deleteCredential(store, credentialId) {
  const credential = await getCredential(store, credentialId)
  if (!credential) {
    return false
  }

  await updateUser(store, credential.userId, (user) => {
    if (!user) {
      return null
    }
    return {
      ...user,
      credentialIds: Array.isArray(user.credentialIds)
        ? user.credentialIds.filter((id) => id !== credentialId)
        : []
    }
  })

  await deleteJson(store, passkeyCredentialKey(credentialId))
  return true
}

async function saveChallenge(store, challengeId, data) {
  await writeJson(store, passkeyChallengeKey(challengeId), {
    ...data,
    createdAt: Date.now(),
    expiresAt: Date.now() + TRANSIENT_TTL_MS
  })
}

async function getAndDeleteChallenge(store, challengeId) {
  const key = passkeyChallengeKey(challengeId)
  const data = await readJson(store, key)
  if (!data) {
    return null
  }

  if (data.expiresAt && data.expiresAt <= Date.now()) {
    await deleteJson(store, key)
    return null
  }

  await deleteJson(store, key)

  if (data.userId) {
    await updateUser(store, data.userId, (user) => {
      if (!user || user.currentChallengeId !== challengeId) {
        return user
      }

      const next = { ...user }
      delete next.currentChallengeId
      return next
    })
  }

  return data
}

async function saveManagementToken(store, tokenId, userId) {
  await writeJson(store, passkeyManagementTokenKey(tokenId), {
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + TRANSIENT_TTL_MS
  })
}

async function validateManagementToken(store, tokenId, expectedUserId) {
  const key = passkeyManagementTokenKey(tokenId)
  const data = await readJson(store, key)
  if (!data) {
    return false
  }

  if (data.expiresAt && data.expiresAt <= Date.now()) {
    await deleteJson(store, key)
    return false
  }

  return data.userId === expectedUserId
}

async function handleGenerateRegistrationOptions(store, data, rpConfig, env) {
  const { username, token } = data

  if (!username || !token) {
    return { code: RES_CODE.FAIL, message: 'Username and token are required' }
  }

  const state = await loadSystemState(store)
  const tokenValid = (state.token && token === state.token) || (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN)
  if (!tokenValid) {
    return { code: RES_CODE.FAIL, message: 'Invalid token' }
  }

  const userId = await generateUserIdFromUsername(username)
  let user = await getUser(store, userId)

  if (user?.currentChallengeId) {
    await deleteJson(store, passkeyChallengeKey(user.currentChallengeId))
  }

  if (user) {
    user = {
      ...user,
      token,
      updatedAt: Date.now()
    }
  } else {
    user = {
      id: userId,
      username,
      token,
      credentialIds: [],
      createdAt: Date.now()
    }
  }

  const challengeBytes = new Uint8Array(32)
  crypto.getRandomValues(challengeBytes)
  const challenge = base64URLEncode(challengeBytes)
  const webAuthnUserIdHash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`open-kounter-passkey:${username}`)
  )
  const webAuthnUserID = base64URLEncode(webAuthnUserIdHash)

  const options = {
    rp: {
      name: rpConfig.rpName,
      id: rpConfig.rpID
    },
    user: {
      id: webAuthnUserID,
      name: username,
      displayName: username
    },
    challenge,
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 }
    ],
    timeout: 60000,
    attestation: 'none',
    excludeCredentials: [],
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
      authenticatorAttachment: 'platform'
    }
  }

  const challengeId = generateUUID()
  user.currentChallengeId = challengeId
  await saveUser(store, user)
  await saveChallenge(store, challengeId, {
    challenge,
    userId,
    username,
    token,
    webAuthnUserID
  })

  return {
    code: RES_CODE.SUCCESS,
    data: {
      options,
      challengeId
    }
  }
}

async function handleVerifyRegistration(store, data, rpConfig) {
  const { challengeId, response } = data

  if (!challengeId || !response) {
    return { code: RES_CODE.FAIL, message: 'Missing required parameters' }
  }

  const challengeData = await getAndDeleteChallenge(store, challengeId)
  if (!challengeData) {
    return { code: RES_CODE.FAIL, message: 'Challenge expired or invalid' }
  }

  try {
    const clientDataJSON = base64URLDecode(response.response.clientDataJSON)
    const clientData = JSON.parse(new TextDecoder().decode(clientDataJSON))

    if (clientData.challenge !== challengeData.challenge) {
      throw new Error('Challenge mismatch')
    }

    if (clientData.origin !== rpConfig.origin) {
      throw new Error(`Origin mismatch: expected ${rpConfig.origin}, got ${clientData.origin}`)
    }

    if (clientData.type !== 'webauthn.create') {
      throw new Error('Invalid operation type')
    }

    const newCredential = {
      id: response.id,
      publicKey: response.response.attestationObject,
      counter: 0,
      transports: response.response.transports || [],
      deviceType: 'multiDevice',
      backedUp: true,
      userId: challengeData.userId,
      webAuthnUserID: challengeData.webAuthnUserID,
      createdAt: Date.now()
    }

    await saveCredential(store, newCredential)

    const allCredentials = await getUserCredentials(store, challengeData.userId)
    for (const credential of allCredentials) {
      if (credential.id !== newCredential.id) {
        await deleteCredential(store, credential.id)
      }
    }

    await updateUser(store, challengeData.userId, (user) => {
      if (!user) {
        return null
      }

      return {
        ...user,
        token: challengeData.token,
        updatedAt: Date.now()
      }
    })

    return {
      code: RES_CODE.SUCCESS,
      data: {
        verified: true,
        credentialId: response.id
      }
    }
  } catch (error) {
    console.error('Registration verification error:', error)
    return { code: RES_CODE.FAIL, message: `Verification failed: ${error.message}` }
  }
}

async function handleGenerateAuthenticationOptions(store, data, rpConfig) {
  const { username } = data

  let allowCredentials = []
  let userId = null

  if (username) {
    userId = await generateUserIdFromUsername(username)
    const user = await getUser(store, userId)
    if (user?.currentChallengeId) {
      await deleteJson(store, passkeyChallengeKey(user.currentChallengeId))
    }

    const credentials = await getUserCredentials(store, userId)
    if (credentials.length === 0) {
      return { code: RES_CODE.NOT_FOUND, message: 'No passkey found for this user' }
    }

    allowCredentials = credentials.map((credential) => ({
      id: credential.id,
      type: 'public-key',
      transports: credential.transports || []
    }))
  }

  const challengeBytes = new Uint8Array(32)
  crypto.getRandomValues(challengeBytes)
  const challenge = base64URLEncode(challengeBytes)

  const options = {
    challenge,
    timeout: 60000,
    rpId: rpConfig.rpID,
    userVerification: 'preferred',
    allowCredentials
  }

  const challengeId = generateUUID()
  if (userId) {
    await updateUser(store, userId, (user) => {
      if (!user) {
        return null
      }

      return {
        ...user,
        currentChallengeId: challengeId
      }
    })
  }

  await saveChallenge(store, challengeId, {
    challenge,
    userId
  })

  return {
    code: RES_CODE.SUCCESS,
    data: {
      options,
      challengeId
    }
  }
}

async function handleVerifyAuthentication(store, data, rpConfig) {
  const { challengeId, response } = data

  if (!challengeId || !response) {
    return { code: RES_CODE.FAIL, message: 'Missing required parameters' }
  }

  const challengeData = await getAndDeleteChallenge(store, challengeId)
  if (!challengeData) {
    return { code: RES_CODE.FAIL, message: 'Challenge expired or invalid' }
  }

  const credential = await getCredential(store, response.id)
  if (!credential) {
    return { code: RES_CODE.FAIL, message: 'Credential not found' }
  }

  const user = await getUser(store, credential.userId)
  if (!user) {
    return { code: RES_CODE.FAIL, message: 'User not found' }
  }

  try {
    const clientDataJSON = base64URLDecode(response.response.clientDataJSON)
    const clientData = JSON.parse(new TextDecoder().decode(clientDataJSON))

    if (clientData.challenge !== challengeData.challenge) {
      throw new Error('Challenge mismatch')
    }

    if (clientData.origin !== rpConfig.origin) {
      throw new Error('Origin mismatch')
    }

    if (clientData.type !== 'webauthn.get') {
      throw new Error('Invalid operation type')
    }

    await writeJson(store, passkeyCredentialKey(credential.id), {
      ...credential,
      lastUsedAt: Date.now()
    })

    return {
      code: RES_CODE.SUCCESS,
      data: {
        verified: true,
        username: user.username,
        token: user.token
      }
    }
  } catch (error) {
    console.error('Authentication verification error:', error)
    return { code: RES_CODE.FAIL, message: `Verification failed: ${error.message}` }
  }
}

async function handleGenerateManagementToken(store, data, rpConfig) {
  const { challengeId, response } = data

  if (!challengeId || !response) {
    return { code: RES_CODE.FAIL, message: 'Missing required parameters' }
  }

  const challengeData = await getAndDeleteChallenge(store, challengeId)
  if (!challengeData) {
    return { code: RES_CODE.FAIL, message: 'Challenge expired or invalid' }
  }

  const credential = await getCredential(store, response.id)
  if (!credential) {
    return { code: RES_CODE.FAIL, message: 'Credential not found' }
  }

  const user = await getUser(store, credential.userId)
  if (!user) {
    return { code: RES_CODE.FAIL, message: 'User not found' }
  }

  try {
    const clientDataJSON = base64URLDecode(response.response.clientDataJSON)
    const clientData = JSON.parse(new TextDecoder().decode(clientDataJSON))

    if (clientData.challenge !== challengeData.challenge) {
      throw new Error('Challenge mismatch')
    }

    if (clientData.origin !== rpConfig.origin) {
      throw new Error('Origin mismatch')
    }

    if (clientData.type !== 'webauthn.get') {
      throw new Error('Invalid operation type')
    }

    const managementToken = generateUUID()
    await saveManagementToken(store, managementToken, credential.userId)

    return {
      code: RES_CODE.SUCCESS,
      data: {
        managementToken,
        username: user.username
      }
    }
  } catch (error) {
    console.error('Management token generation error:', error)
    return { code: RES_CODE.FAIL, message: `Verification failed: ${error.message}` }
  }
}

async function handleListCredentials(store, data) {
  const { username } = data

  if (!username) {
    return { code: RES_CODE.FAIL, message: 'Username is required' }
  }

  const userId = await generateUserIdFromUsername(username)
  const credentials = await getUserCredentials(store, userId)
  return {
    code: RES_CODE.SUCCESS,
    data: credentials.map((credential) => ({
      id: credential.id,
      deviceType: credential.deviceType,
      backedUp: credential.backedUp,
      createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt
    }))
  }
}

async function handleDeleteCredential(store, data) {
  const { credentialId, username, managementToken } = data

  if (!credentialId || !username) {
    return { code: RES_CODE.FAIL, message: 'Credential ID and username are required' }
  }

  if (!managementToken) {
    return { code: RES_CODE.FAIL, message: 'Management token required' }
  }

  const credential = await getCredential(store, credentialId)
  if (!credential) {
    return { code: RES_CODE.NOT_FOUND, message: 'Credential not found' }
  }

  const userId = await generateUserIdFromUsername(username)
  if (credential.userId !== userId) {
    return { code: RES_CODE.FAIL, message: 'Unauthorized' }
  }

  const isValid = await validateManagementToken(store, managementToken, userId)
  if (!isValid) {
    return { code: RES_CODE.FAIL, message: 'Invalid or expired management token' }
  }

  await deleteCredential(store, credentialId)
  return {
    code: RES_CODE.SUCCESS,
    data: { deleted: true }
  }
}

async function handleCancelChallenge(store, data) {
  if (data?.challengeId) {
    await getAndDeleteChallenge(store, data.challengeId)
  }
  return {
    code: RES_CODE.SUCCESS,
    message: 'Challenge cleared'
  }
}

function generateUUID() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID().replace(/-/g, '')
  }

  return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/[x]/g, () => {
    return ((Math.random() * 16) | 0).toString(16)
  })
}

function base64URLEncode(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function base64URLDecode(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4))
  const binary = atob(base64 + padding)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

async function generateUserIdFromUsername(username) {
  const encoder = new TextEncoder()
  const source = encoder.encode(`open-kounter-passkey:${username}`)
  const hashBuffer = await crypto.subtle.digest('SHA-256', source)
  return base64URLEncode(hashBuffer)
}

export default { onRequest }