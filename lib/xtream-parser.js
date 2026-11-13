import { encryptPassword, decryptPassword } from '@/lib/iptv-crypto';

/**
 * Strips invisible Unicode directional marks (common when copying URLs from Arabic chats),
 * control characters, and surrounding whitespace.
 */
export function stripInvisible(value) {
  return String(value || '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00A0\r\n\t]/g, '')
    .trim();
}

/**
 * Sanitizes a raw URL string: removes invisible characters, surrounding quotes/brackets,
 * HTML-escaped ampersands (&amp;, &#38;, &#x26;), and duplicate http:// prefixes.
 */
export function sanitizeRawUrl(rawUrl) {
  let cleaned = stripInvisible(rawUrl)
    .replace(/^['"<>]+|['"<>]+$/g, '')
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&#x26;/gi, '&')
    .replace(/^(https?:\/\/)+(https?:\/\/)/i, '$2');

  if (cleaned && !/^https?:\/\//i.test(cleaned)) {
    cleaned = `http://${cleaned}`;
  }
  return cleaned;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parses a playlist URL and optional username/password on the server.
 *
 * - If Xtream credentials (baseUrl + username + password) are found (either from explicit
 *   fields or extracted from query/path/userInfo of an M3U link), returns:
 *   `{ isXtream: true, type: 'xtream', url: baseUrl, username, password }`
 * - Otherwise returns it as a direct M3U link:
 *   `{ isXtream: false, type: 'm3u', url: cleanedUrl, username: null, password: null }`
 */
export function parsePlaylistInput({ url, username = null, password = null }) {
  const cleanedUrl = sanitizeRawUrl(url);
  let user = stripInvisible(username);
  let pass = stripInvisible(password);

  if (!cleanedUrl) {
    return {
      isXtream: false,
      type: 'm3u',
      url: '',
      username: null,
      password: null,
    };
  }

  try {
    const parsed = new URL(cleanedUrl);

    // 0. Static hosts that never host Xtream panels (GitHub, Pastebin, Google Drive, etc.)
    const isStaticHost = /(github\.io|githubusercontent\.com|pastebin\.com|raw\.github|drive\.google\.com)$/i.test(parsed.hostname);
    if (isStaticHost) {
      throw new Error('Static host, treat as m3u');
    }

    // 1. Check userInfo in authority (http://user:pass@host:port/...)
    if ((!user || !pass) && parsed.username && parsed.password) {
      if (!user) user = safeDecode(parsed.username).trim();
      if (!pass) pass = safeDecode(parsed.password).trim();
    }

    // 2. Parse raw query string directly so '+' in passwords is NEVER turned into a space
    const rawQuery = cleanedUrl.includes('?')
      ? cleanedUrl.split('?').slice(1).join('?').split('#')[0]
      : '';
    if ((!user || !pass) && rawQuery) {
      for (const pair of rawQuery.split(/[&;]/)) {
        if (!pair) continue;
        const eqIdx = pair.indexOf('=');
        if (eqIdx <= 0) continue;
        const k = safeDecode(pair.slice(0, eqIdx))
          .trim()
          .replace(/^amp;/i, '')
          .toLowerCase();
        const v = safeDecode(pair.slice(eqIdx + 1)).trim();
        if (!v) continue;
        if (!user && (k === 'username' || k === 'user' || k === 'u' || k === 'login')) {
          user = v;
        } else if (!pass && (k === 'password' || k === 'pass' || k === 'p' || k === 'pwd')) {
          pass = v;
        }
      }
    }

    // 3. إذا لم يتم العثور على اسم المستخدم وكلمة المرور في المعلمات، فهو رابط M3U مباشر
    if (user && pass) {
      const segments = parsed.pathname.split('/').filter(Boolean).map(s => s.trim());
      // Strip script names (get.php, player_api.php, panel_api.php, xmltv.php, .m3u, .m3u8, c, portal)
      const kept = segments
        .filter(
          (s) =>
            !/\.(php|m3u8?)$/i.test(s) &&
            !/^(c|portal|player_api|panel_api|get|xmltv)$/i.test(s),
        );
      const basePath = kept.length ? `/${kept.join('/')}` : '';
      const baseUrl = `${parsed.protocol}//${parsed.host}${basePath}`;

      return {
        isXtream: true,
        type: 'xtream',
        url: baseUrl,
        username: user,
        password: pass,
      };
    }
  } catch {
    // Fall through and return as direct M3U link
  }

  return {
    isXtream: false,
    type: 'm3u',
    url: cleanedUrl,
    username: null,
    password: null,
  };
}

/**
 * Resolves shortened URLs (e.g. bit.ly, tinyurl) on the server when adding/editing a playlist,
 * stopping as soon as a redirect Location header contains Xtream credentials so the IPTV
 * provider's `get.php` is never hit.
 */
export async function resolveAndParsePlaylistInput({ url, username = null, password = null }) {
  const initial = parsePlaylistInput({ url, username, password });
  if (initial.isXtream || !initial.url) {
    return initial;
  }

  // If the URL already ends with .m3u or .m3u8, it is a direct M3U file; no redirect probe needed
  const cleanPath = initial.url.split('?')[0];
  if (/\.m3u8?$/i.test(cleanPath)) {
    return initial;
  }

  let currentUrl = initial.url;
  for (let hop = 0; hop < 5; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const res = await fetch(currentUrl, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'IPTVSmartersPlayer',
          Accept: '*/*',
        },
      });
      clearTimeout(timer);

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) break;
        const nextUrl = new URL(location, currentUrl).toString();
        const parsedRedirect = parsePlaylistInput({ url: nextUrl, username, password });
        if (parsedRedirect.isXtream) {
          // Immediately return Xtream credentials without hitting the target IPTV server!
          return parsedRedirect;
        }
        currentUrl = nextUrl;
      } else {
        break;
      }
    } catch {
      clearTimeout(timer);
      break;
    }
  }

  return parsePlaylistInput({ url: currentUrl, username, password });
}

/**
 * Normalizes an existing database playlist row and, if it was stored as an M3U link that
 * actually contains Xtream credentials, migrates it in the database so the DB record itself
 * is permanently corrected.
 */
export async function normalizeAndMigratePlaylistRow(supabase, row) {
  const plainPass = row.password ? decryptPassword(row.password) : null;
  const parsed = parsePlaylistInput({
    url: row.url,
    username: row.username,
    password: plainPass,
  });

  const targetType = parsed.isXtream ? 'xtream' : 'm3u';
  const targetUrl = parsed.url;
  const targetUser = parsed.isXtream ? parsed.username : null;
  const targetPlainPass = parsed.isXtream ? parsed.password : null;

  const needsDbUpdate =
    row.type !== targetType ||
    row.url !== targetUrl ||
    (row.username || null) !== targetUser ||
    (plainPass || null) !== targetPlainPass;

  if (needsDbUpdate && supabase && row.id) {
    try {
      await supabase
        .from('playlists')
        .update({
          type: targetType,
          url: targetUrl,
          username: targetUser,
          password: targetPlainPass ? encryptPassword(targetPlainPass) : null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);
    } catch (err) {
      console.error('Failed to auto-migrate playlist row in DB:', err);
    }
  }

  return {
    id: row.id,
    device_id: row.device_id,
    name: row.name,
    type: targetType,
    url: targetUrl,
    username: targetUser,
    password: targetPlainPass,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
