/**
 * In-memory sliding window rate limiter
 * Protects against Device Key brute-forcing and API abuse
 */

// Store failed login attempts: Map<key, { count: number, resetAt: number }>()
const failedAttemptsMap = new Map();

// General requests rate limit store: Map<key, { count: number, resetAt: number }>()
const requestLimitMap = new Map();

// Periodic cleanup of expired entries every 5 minutes to prevent memory leak
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, value] of failedAttemptsMap.entries()) {
      if (now > value.resetAt) {
        failedAttemptsMap.delete(key);
      }
    }
    for (const [key, value] of requestLimitMap.entries()) {
      if (now > value.resetAt) {
        requestLimitMap.delete(key);
      }
    }
  }, 5 * 60 * 1000).unref?.();
}

/**
 * Extracts client IP address safely from Request.
 * Prioritizes platform-verified headers (Vercel / Cloudflare) that cannot be spoofed by
 * client-supplied X-Forwarded-For prefixes.
 */
export function getClientIp(request) {
  if (!request) return '127.0.0.1';

  const vercelForwardedFor = request.headers.get('x-vercel-forwarded-for');
  if (vercelForwardedFor) {
    const firstIp = vercelForwardedFor.split(',')[0].trim();
    if (firstIp) return firstIp;
  }

  const cfConnectingIp = request.headers.get('cf-connecting-ip');
  if (cfConnectingIp) return cfConnectingIp.trim();

  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();

  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const ips = forwardedFor
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean);
    if (ips.length > 0) {
      // Use the last hop appended by the reverse proxy rather than a client-spoofed prefix
      return ips[ips.length - 1];
    }
  }

  return '127.0.0.1';
}

/**
 * Check if login attempt is allowed for given IP and/or MAC
 * Max 5 failed attempts per 15 minutes by default
 */
export function checkLoginRateLimit(identifier, maxAttempts = 5, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const record = failedAttemptsMap.get(identifier);

  if (!record || now > record.resetAt) {
    return {
      allowed: true,
      remaining: maxAttempts,
      resetAt: now + windowMs,
    };
  }

  if (record.count >= maxAttempts) {
    const retryAfterSeconds = Math.ceil((record.resetAt - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      resetAt: record.resetAt,
      retryAfterSeconds,
    };
  }

  return {
    allowed: true,
    remaining: maxAttempts - record.count,
    resetAt: record.resetAt,
  };
}

/**
 * Record a failed login attempt
 */
export function recordFailedLogin(identifier, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const record = failedAttemptsMap.get(identifier);

  if (!record || now > record.resetAt) {
    failedAttemptsMap.set(identifier, {
      count: 1,
      resetAt: now + windowMs,
    });
  } else {
    record.count += 1;
  }
}

/**
 * Reset failed attempts upon successful authentication
 */
export function resetLoginRateLimit(identifier) {
  failedAttemptsMap.delete(identifier);
}

/**
 * General endpoint rate limiter
 * e.g. limit to 60 requests per 1 minute
 */
export function checkEndpointRateLimit(key, maxRequests = 60, windowMs = 60 * 1000) {
  const now = Date.now();
  const record = requestLimitMap.get(key);

  if (!record || now > record.resetAt) {
    requestLimitMap.set(key, {
      count: 1,
      resetAt: now + windowMs,
    });
    return {
      allowed: true,
      remaining: maxRequests - 1,
      resetAt: now + windowMs,
    };
  }

  if (record.count >= maxRequests) {
    const retryAfterSeconds = Math.ceil((record.resetAt - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      resetAt: record.resetAt,
      retryAfterSeconds,
    };
  }

  record.count += 1;
  return {
    allowed: true,
    remaining: maxRequests - record.count,
    resetAt: record.resetAt,
  };
}
