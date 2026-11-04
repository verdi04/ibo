import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createPrivateKey,
  createSign,
  hkdfSync,
  randomBytes,
  randomInt,
  createHash,
  timingSafeEqual,
} from 'node:crypto';

const ENCRYPTED_FIELDS = [
  'm3u_link',
  'xtream_url',
  'xtream_username',
  'xtream_password',
];

/**
 * MAC Address normalization and validation
 * Normalizes any format (e.g. 00:1a:2b:3c:4d:5e, 00-1a-2b-3c-4d-5e, 001a2b3c4d5e)
 * to standard uppercase format: 00:1A:2B:3C:4D:5E
 */
export function normalizeMac(mac) {
  if (typeof mac !== 'string') return null;
  const clean = mac.trim().toUpperCase().replace(/[^0-9A-F]/g, '');
  if (clean.length !== 12) return null;
  const parts = clean.match(/.{1,2}/g);
  return parts ? parts.join(':') : null;
}

export function isValidMac(mac) {
  return normalizeMac(mac) !== null;
}

/**
 * Constant-time comparison for bearer secrets (device keys, token signatures).
 * Device keys are only 10^6 wide, so a timing oracle on a plain !== would be exploitable.
 */
export function safeEquals(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Checks if a 6-digit key follows a trivial, sequential, or repetitive pattern
 */
export function isSequentialOrTrivial(digits) {
  if (typeof digits !== 'string' || digits.length !== 6 || !/^\d{6}$/.test(digits)) {
    return true;
  }

  // All identical digits (e.g. 000000, 111111, 777777, 999999)
  if (/^(\d)\1{5}$/.test(digits)) {
    return true;
  }

  // Fewer than 3 unique digits (e.g. 111112, 888898, 222322)
  const uniqueDigits = new Set(digits);
  if (uniqueDigits.size <= 2) {
    return true;
  }

  // 4 or more consecutive identical digits (e.g. 111145, 999923)
  if (/(\d)\1{3,}/.test(digits)) {
    return true;
  }

  // Repetitive 2-digit pattern (e.g. 121212, 454545, 898989)
  if (digits.slice(0, 2).repeat(3) === digits) {
    return true;
  }

  // Repetitive 3-digit pattern (e.g. 123123, 789789)
  if (digits.slice(0, 3).repeat(2) === digits) {
    return true;
  }

  const nums = digits.split('').map(Number);

  // Sequential ascending (e.g. 123456, 012345, 234567, 345678, 456789)
  let isAsc = true;
  // Sequential descending (e.g. 654321, 987654, 876543, 765432, 543210)
  let isDesc = true;

  for (let i = 1; i < nums.length; i++) {
    if (nums[i] !== nums[i - 1] + 1) isAsc = false;
    if (nums[i] !== nums[i - 1] - 1) isDesc = false;
  }

  if (isAsc || isDesc) {
    return true;
  }

  // Simple steps of 2 (e.g. 024680, 135791)
  let isStep2Asc = true;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] !== (nums[i - 1] + 2) % 10) isStep2Asc = false;
  }
  if (isStep2Asc) {
    return true;
  }

  return false;
}

/**
 * Generates a secure, non-repeating, non-sequential 6-digit Device Key
 */
export function generateDeviceKey() {
  let attempts = 0;
  while (attempts < 1000) {
    attempts++;
    // Generate a 6-digit number between 100000 and 999999
    const key = String(randomInt(100000, 1000000));
    if (!isSequentialOrTrivial(key)) {
      return key;
    }
  }

  // Fallback to cryptographically safe pseudo-random 6-digit key
  const fallbackKey = String(randomInt(248193, 937162));
  return fallbackKey;
}

/**
 * Retrieves the 32-byte AES-256 key from environment variables.
 * Accepts 64-hex-char strings or derives via SHA-256 for passphrases.
 * No fallback: key material never appears in source.
 */
export function getEncryptionKey() {
  const rawKey =
    process.env.APP_SECRET_KEY ||
    process.env.IPTV_ENCRYPTION_KEY ||
    process.env.DEVICE_SECRET_KEY;

  if (!rawKey) {
    throw new Error(
      'APP_SECRET_KEY (or IPTV_ENCRYPTION_KEY / DEVICE_SECRET_KEY) must be set in the environment.',
    );
  }

  if (/^[\da-f]{64}$/i.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }

  // Derive 32-byte key from arbitrary passphrase
  return createHash('sha256').update(rawKey, 'utf8').digest();
}

/**
 * Derives a per-handshake AES-256 session key via ephemeral ECDH (P-256) + HKDF-SHA256.
 * The client sends its ephemeral public point (hex, 04||X||Y); the server replies with
 * its own ephemeral point, and both sides derive the same key:
 *   HKDF(shared, salt = normalized MAC, info = ECDH_HANDSHAKE_INFO, 32)
 * No long-term secret is stored on either side.
 */
export const ECDH_HANDSHAKE_INFO = 'reda-iptv-handshake-v2';

export function deriveEcdhSessionKey(clientPublicKeyHex, saltText) {
  const point = Buffer.from(clientPublicKeyHex, 'hex');
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('Invalid client ECDH public key: expected 65-byte uncompressed point (04||X||Y).');
  }

  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();

  const shared = ecdh.computeSecret(point);
  const aesKey = Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.from(String(saltText), 'utf8'),
      Buffer.from(ECDH_HANDSHAKE_INFO, 'utf8'),
      32,
    ),
  );

  return {
    aesKey,
    serverPublicKey: ecdh.getPublicKey('hex', 'uncompressed'),
  };
}

/**
 * Protocol v3: the server proves its identity on pair-mode handshake responses with an
 * ECDSA P-256 signature over the full transcript, using the long-term key in
 * IPTV_SIGNING_KEY_B64 (base64 PKCS#8 DER) or IPTV_SIGNING_KEY_PEM. The APK pins the
 * matching public key, so an impostor on the network can no longer be trusted.
 */
export const HANDSHAKE_SIGNATURE_PREFIX = 'IPTV-HS-v1';

export function getSigningPrivateKey() {
  const raw = process.env.IPTV_SIGNING_KEY_PEM || process.env.IPTV_SIGNING_KEY_B64;
  if (!raw) {
    throw new Error(
      'Handshake signing key is not configured: set IPTV_SIGNING_KEY_B64 (or IPTV_SIGNING_KEY_PEM).',
    );
  }

  if (raw.includes('-----BEGIN')) {
    return createPrivateKey({ key: raw.replace(/\\n/g, '\n'), format: 'pem' });
  }

  return createPrivateKey({
    key: Buffer.from(raw.trim(), 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
}

const lowerHex = (value) => String(value).trim().toLowerCase();

/**
 * Canonical transcript both sides must agree on:
 *   IPTV-HS-v1|MAC|clientPubkey|serverPubkey|iv:tag:ciphertext
 * The MAC stays uppercase colon-separated, every hex component is lowercased.
 */
export function buildHandshakeSignatureBase({ mac, clientPublicKey, serverPublicKey, combined }) {
  const parts = String(combined).split(':');
  if (parts.length !== 3 || parts.some((p) => !p)) {
    throw new Error('Invalid combined payload while building handshake signature base.');
  }

  return [
    HANDSHAKE_SIGNATURE_PREFIX,
    String(mac).toUpperCase(),
    lowerHex(clientPublicKey),
    lowerHex(serverPublicKey),
    parts.map(lowerHex).join(':'),
  ].join('|');
}

export function signHandshakeResponse({ mac, clientPublicKey, serverPublicKey, combined }) {
  const signatureBase = buildHandshakeSignatureBase({ mac, clientPublicKey, serverPublicKey, combined });
  const privateKey = getSigningPrivateKey();

  const signer = createSign('sha256');
  signer.update(Buffer.from(signatureBase, 'utf8'));

  return {
    signatureBase,
    signature: signer.sign({ key: privateKey, dsaEncoding: 'der' }).toString('hex'),
  };
}

/**
 * AES-256-GCM symmetric encryption for TV device response payloads
 */
export function encryptPayload(payload, customKey) {
  const key = customKey ? (Buffer.isBuffer(customKey) ? customKey : createHash('sha256').update(String(customKey)).digest()) : getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const ciphertext = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const ivHex = iv.toString('hex');
  const tagHex = tag.toString('hex');
  const dataHex = ciphertext.toString('hex');

  return {
    iv: ivHex,
    tag: tagHex,
    data: dataHex,
    combined: `${ivHex}:${tagHex}:${dataHex}`,
  };
}

/**
 * AES-256-GCM symmetric decryption for TV device response payloads
 */
export function decryptPayload(encrypted, customKey) {
  const key = customKey ? (Buffer.isBuffer(customKey) ? customKey : createHash('sha256').update(String(customKey)).digest()) : getEncryptionKey();
  let iv, tag, ciphertext;

  if (typeof encrypted === 'string') {
    const parts = encrypted.split(':');
    if (parts.length === 3) {
      iv = Buffer.from(parts[0], 'hex');
      tag = Buffer.from(parts[1], 'hex');
      ciphertext = Buffer.from(parts[2], 'hex');
    } else {
      throw new Error('Invalid encrypted payload string format. Expected iv:tag:ciphertext.');
    }
  } else if (encrypted && typeof encrypted === 'object') {
    if (!encrypted.iv || !encrypted.tag || !encrypted.data) {
      throw new Error('Invalid encrypted payload object. Expected iv, tag, and data properties.');
    }
    iv = Buffer.from(encrypted.iv, 'hex');
    tag = Buffer.from(encrypted.tag, 'hex');
    ciphertext = Buffer.from(encrypted.data, 'hex');
  } else {
    throw new Error('Invalid encrypted payload input.');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');

  try {
    return JSON.parse(decrypted);
  } catch {
    return decrypted;
  }
}

/**
 * Encrypts Xtream password for database storage
 */
export function encryptPassword(password) {
  if (password === null || password === undefined || password === '') {
    return null;
  }
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(password), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Decrypts Xtream password from database
 */
export function decryptPassword(encrypted) {
  if (!encrypted || typeof encrypted !== 'string') {
    return null;
  }
  if (!encrypted.startsWith('enc:')) {
    return encrypted; // plain text fallback
  }

  const parts = encrypted.slice(4).split(':');
  if (parts.length !== 3) {
    return encrypted;
  }

  const [ivHex, tagHex, dataHex] = parts;
  const key = getEncryptionKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

// -----------------------------------------------------------------------------
// Legacy table encryption helpers (Kept for backward compatibility)
// -----------------------------------------------------------------------------

function getAssociatedData(macAddress, field) {
  return Buffer.from(`${macAddress}\0${field}`, 'utf8');
}

function toByteaHex(value) {
  return `\\x${value.toString('hex')}`;
}

function fromByteaHex(value) {
  if (typeof value !== 'string' || !value.startsWith('\\x')) {
    throw new Error('Stored IPTV value is not a valid BYTEA hex value.');
  }

  const hex = value.slice(2);
  if (hex.length % 2 !== 0 || !/^[\da-f]*$/i.test(hex)) {
    throw new Error('Stored IPTV value contains invalid BYTEA data.');
  }

  return Buffer.from(hex, 'hex');
}

export function encryptIptvFields(record) {
  const key = getEncryptionKey();

  return Object.fromEntries(
    ENCRYPTED_FIELDS.map((field) => {
      const value = record[field];

      if (value === null || value === undefined) {
        return [field, null];
      }

      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(getAssociatedData(record.mac_address, field));

      const ciphertext = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();

      return [field, toByteaHex(Buffer.concat([iv, tag, ciphertext]))];
    }),
  );
}

export function decryptIptvFields(record) {
  const key = getEncryptionKey();

  return {
    ...record,
    ...Object.fromEntries(
      ENCRYPTED_FIELDS.map((field) => {
        const value = record[field];

        if (value === null || value === undefined) {
          return [field, null];
        }

        const encrypted = fromByteaHex(value);
        if (encrypted.length < 28) {
          throw new Error(`Stored IPTV field "${field}" is too short.`);
        }

        const iv = encrypted.subarray(0, 12);
        const tag = encrypted.subarray(12, 28);
        const ciphertext = encrypted.subarray(28);
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(getAssociatedData(record.mac_address, field));
        decipher.setAuthTag(tag);

        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString('utf8');

        return [field, plaintext];
      }),
    ),
  };
}
