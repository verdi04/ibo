import { createHmac } from 'node:crypto';
import { supabase } from './supabase.js';
import { normalizeMac, safeEquals } from './iptv-crypto.js';
import {
  getClientIp,
  checkLoginRateLimit,
  recordFailedLogin,
  resetLoginRateLimit,
} from './rate-limiter.js';

const CREDENTIAL_WINDOW_MS = 15 * 60 * 1000;
const MAX_CREDENTIAL_ATTEMPTS = 5;
const MAX_GLOBAL_MAC_ATTEMPTS = 10;
const ADMIN_SESSION_HOURS = 8;

function getAuthSecret() {
  const secret =
    process.env.PORTAL_JWT_SECRET ||
    process.env.APP_SECRET_KEY ||
    process.env.IPTV_ENCRYPTION_KEY;

  // No fallback: a known default secret would let anyone mint valid portal sessions.
  if (!secret) {
    throw new Error(
      'PORTAL_JWT_SECRET (or APP_SECRET_KEY / IPTV_ENCRYPTION_KEY) must be set in the environment to sign portal sessions.',
    );
  }

  return secret;
}

/**
 * Computes a short HMAC fingerprint of the current device_key so portal tokens are
 * automatically invalidated the moment the device rotates its key.
 */
export function fingerprintDeviceKey(deviceKey) {
  if (!deviceKey) return '';
  return createHmac('sha256', getAuthSecret())
    .update(`device-key-fp:${String(deviceKey).trim()}`)
    .digest('base64url')
    .slice(0, 24);
}

/**
 * Creates an HMAC-SHA256 signed session token for authenticated portal users.
 * If `device_key` is provided in payload, stores only its HMAC fingerprint (`key_fp`)
 * so the raw key is never exposed in the token and rotating the key revokes old sessions.
 */
export function createPortalToken(payload, expiresInHours = 24) {
  const exp = Date.now() + expiresInHours * 60 * 60 * 1000;
  const { device_key, ...rest } = payload || {};
  const data = {
    ...rest,
    ...(device_key ? { key_fp: fingerprintDeviceKey(device_key) } : {}),
    exp,
  };

  const encodedPayload = Buffer.from(JSON.stringify(data), 'utf8').toString(
    'base64url',
  );
  const signature = createHmac('sha256', getAuthSecret())
    .update(encodedPayload)
    .digest('base64url');

  return `${encodedPayload}.${signature}`;
}

/**
 * Verifies an HMAC-SHA256 signed portal token
 */
export function verifyPortalToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) {
    return null;
  }

  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = createHmac('sha256', getAuthSecret())
    .update(encodedPayload)
    .digest('base64url');

  if (!safeEquals(signature, expectedSignature)) {
    return null;
  }

  try {
    const data = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    );

    if (data.exp && Date.now() > data.exp) {
      return null; // Expired token
    }

    return data;
  } catch {
    return null;
  }
}

function getAdminPassword() {
  const password = process.env.ADMIN_PASSWORD;

  // Fail closed: without an admin secret nobody can mint an entitlement session.
  if (!password) {
    throw new Error(
      'ADMIN_PASSWORD must be set in the environment to sign in as a seller/admin.',
    );
  }

  return password;
}

/**
 * Checks an admin password and returns a seller session token.
 * A device key proves who owns a device; it never entitles anyone to a subscription,
 * so activation privileges live in a separate token kind.
 */
export function loginAdmin(rawPassword) {
  const password = typeof rawPassword === 'string' ? rawPassword : '';
  if (!password || !safeEquals(password, getAdminPassword())) {
    return null;
  }

  return createPortalToken({ role: 'admin' }, ADMIN_SESSION_HOURS);
}

/**
 * Returns the admin session payload for a request, or null.
 * Device tokens carry `device_id` and no role, so they can never satisfy this check.
 */
export function verifyAdminRequest(request) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const verified = verifyPortalToken(authHeader.slice(7).trim());
  return verified && verified.role === 'admin' ? verified : null;
}

/**
 * Helper to authenticate incoming portal requests as a *device*.
 * Supports:
 * 1. Authorization: Bearer <device token>  (admin tokens are rejected here: no device_id)
 * 2. Headers: x-device-mac & x-device-key
 */
export async function authenticatePortalRequest(request) {
  const authHeader = request.headers.get('authorization');
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }

  if (token) {
    const verified = verifyPortalToken(token);
    if (verified && verified.device_id && verified.key_fp) {
      const { data: device, error } = await supabase
        .from('devices')
        .select('*')
        .eq('id', verified.device_id)
        .maybeSingle();

      if (
        !error &&
        device &&
        safeEquals(verified.key_fp, fingerprintDeviceKey(device.device_key))
      ) {
        return device;
      }
    }
  }

  // Fallback to MAC + Key headers
  const headerMac = request.headers.get('x-device-mac');
  const headerKey = request.headers.get('x-device-key');

  if (headerMac && headerKey) {
    return findDeviceByCredentials(request, headerMac, headerKey);
  }

  return null;
}

function credentialLimitKey(request, normalizedMac) {
  return `credentials:${getClientIp(request)}:${normalizedMac}`;
}

function globalMacLimitKey(normalizedMac) {
  return `mac_lock:${normalizedMac}`;
}

function recordCredentialFailure(request, rawMac) {
  const normalizedMac = normalizeMac(rawMac);
  if (normalizedMac) {
    recordFailedLogin(
      credentialLimitKey(request, normalizedMac),
      CREDENTIAL_WINDOW_MS,
    );
    recordFailedLogin(
      globalMacLimitKey(normalizedMac),
      CREDENTIAL_WINDOW_MS,
    );
  }
}

function resetCredentialAttempts(request, rawMac) {
  const normalizedMac = normalizeMac(rawMac);
  if (normalizedMac) {
    resetLoginRateLimit(credentialLimitKey(request, normalizedMac));
    resetLoginRateLimit(globalMacLimitKey(normalizedMac));
  }
}

/**
 * Resolves a device from MAC + device key, guarded by the attempt budget.
 * Returns null for unknown devices, wrong keys, and blocked callers.
 */
export async function findDeviceByCredentials(request, rawMac, rawKey) {
  const normalizedMac = normalizeMac(rawMac);
  const claimedKey = typeof rawKey === 'string' ? rawKey.trim() : '';

  if (!normalizedMac || !claimedKey) {
    return null;
  }

  const attempt = checkLoginRateLimit(
    credentialLimitKey(request, normalizedMac),
    MAX_CREDENTIAL_ATTEMPTS,
    CREDENTIAL_WINDOW_MS,
  );
  const globalMacAttempt = checkLoginRateLimit(
    globalMacLimitKey(normalizedMac),
    MAX_GLOBAL_MAC_ATTEMPTS,
    CREDENTIAL_WINDOW_MS,
  );
  if (!attempt.allowed || !globalMacAttempt.allowed) {
    return null;
  }

  const { data: device, error } = await supabase
    .from('devices')
    .select('*')
    .eq('mac_address', normalizedMac)
    .maybeSingle();

  if (error || !device || !safeEquals(claimedKey, device.device_key)) {
    recordCredentialFailure(request, normalizedMac);
    return null;
  }

  resetCredentialAttempts(request, normalizedMac);
  return device;
}
