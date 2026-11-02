import { createHmac } from 'node:crypto';
import { supabase } from './supabase.js';
import { normalizeMac } from './iptv-crypto.js';

function getAuthSecret() {
  const secret =
    process.env.PORTAL_JWT_SECRET ||
    process.env.APP_SECRET_KEY ||
    process.env.IPTV_ENCRYPTION_KEY ||
    'iptv-portal-auth-secret-key-default-dev';
  return secret;
}

/**
 * Creates an HMAC-SHA256 signed session token for authenticated portal users
 */
export function createPortalToken(payload, expiresInHours = 24) {
  const exp = Date.now() + expiresInHours * 60 * 60 * 1000;
  const data = {
    ...payload,
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

  if (signature !== expectedSignature) {
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

/**
 * Helper to authenticate incoming portal requests
 * Supports:
 * 1. Authorization: Bearer <token>
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
    if (verified && verified.device_id) {
      const { data: device, error } = await supabase
        .from('devices')
        .select('*')
        .eq('id', verified.device_id)
        .maybeSingle();

      if (!error && device) {
        return device;
      }
    }
  }

  // Fallback to MAC + Key headers
  const headerMac = request.headers.get('x-device-mac');
  const headerKey = request.headers.get('x-device-key');

  if (headerMac && headerKey) {
    const normalizedMac = normalizeMac(headerMac);
    if (normalizedMac) {
      const { data: device, error } = await supabase
        .from('devices')
        .select('*')
        .eq('mac_address', normalizedMac)
        .eq('device_key', headerKey.trim())
        .maybeSingle();

      if (!error && device) {
        return device;
      }
    }
  }

  return null;
}
