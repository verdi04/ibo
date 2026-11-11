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

    // 3. Check path-based Xtream M3U patterns:
    //    /playlist/{user}/{pass}/..., /live/{user}/{pass}/..., /movie/{user}/{pass}/...,
    //    /series/{user}/{pass}/..., /m3u/{user}/{pass}, /get/{user}/{pass},
    //    /{user}/{pass}/m3u_plus, or /{user}/{pass}
    const segments = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map((s) => s.trim());
    let prefixEnd = segments.length;

    const markers = ['playlist', 'live', 'movie', 'series', 'm3u', 'get', 'xtream'];
    const markerIdx = segments.findIndex((s) => markers.includes(s.toLowerCase()));

    if (markerIdx !== -1 && markerIdx + 2 < segments.length) {
      if (!user || !pass) {
        const candidateUser = safeDecode(segments[markerIdx + 1]).trim();
        const candidatePass = safeDecode(segments[markerIdx + 2])
          .trim()
          .replace(/\.(m3u8?|ts)$/i, '');
        if (candidateUser && candidatePass) {
          if (!user) user = candidateUser;
          if (!pass) pass = candidatePass;
        }
      }
      prefixEnd = markerIdx;
    } else if (
      segments.length >= 2 &&
      segments.length <= 3 &&
      !/\.(php|m3u8?|txt|json|xml)$/i.test(segments[0]) &&
      !/\.(php|m3u8?|txt|json|xml)$/i.test(segments[1])
    ) {
      const thirdSeg = segments[2] || '';
      const thirdIsOutputHint =
        segments.length === 2 ||
        /^(m3u_plus|m3u8?|ts|hls|mpegts|output)$/i.test(thirdSeg) ||
        /\.(m3u8?|ts)$/i.test(thirdSeg);

      // Avoid misclassifying generic static URLs like /iptv/channels.m3u or /files/list
      const commonStaticFolders = [
        'iptv',
        'playlist',
        'playlists',
        'channels',
        'streams',
        'tv',
        'raw',
        'master',
        'main',
        'download',
        'files',
        'static',
        'public',
      ];
      const looksLikeStaticPath =
        segments.length === 2 &&
        commonStaticFolders.includes(segments[0].toLowerCase());

      if (thirdIsOutputHint && !looksLikeStaticPath) {
        if (!user || !pass) {
          const candidateUser = safeDecode(segments[0]).trim();
          const candidatePass = safeDecode(segments[1])
            .trim()
            .replace(/\.(m3u8?|ts)$/i, '');
          if (candidateUser && candidatePass) {
            user = candidateUser;
            pass = candidatePass;
          }
        }
        prefixEnd = 0;
      }
    }

    if (user && pass) {
      // Strip script names (get.php, player_api.php, panel_api.php, xmltv.php, .m3u, .m3u8, c, portal)
      const kept = segments
        .slice(0, prefixEnd)
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
