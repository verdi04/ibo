import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENV_VAR = 'IPTV_SIGNING_KEY_B64';
const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
const force = process.argv.includes('--force');

function publicSpkiHexFromPrivate(privateB64) {
  const priv = createPrivateKey({ key: Buffer.from(privateB64, 'base64'), format: 'der', type: 'pkcs8' });
  return createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('hex');
}

let privateB64;
let publicSpkiHex;
let created = false;

const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const currentLine = existing.split(/\r?\n/).find((l) => l.startsWith(`${ENV_VAR}=`));

if (currentLine && !force) {
  privateB64 = currentLine.slice(ENV_VAR.length + 1).trim();
  publicSpkiHex = publicSpkiHexFromPrivate(privateB64);
} else {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  privateB64 = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  publicSpkiHex = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
  created = true;

  const next = existing
    .split(/\r?\n/)
    .filter((l) => !l.startsWith(`${ENV_VAR}=`))
    .join('\n')
    .replace(/\n*$/, '\n');
  writeFileSync(envPath, `${next}${ENV_VAR}=${privateB64}\n`, 'utf8');
}

console.log(created ? 'Generated a new ECDSA P-256 signing keypair.' : 'Using the existing key from .env.local (pass --force to rotate).');
if (created) console.log(`Private key stored in iptv-admin/.env.local as ${ENV_VAR} (gitignored).`);
console.log('');
console.log('Pin this public key in NetworkUtils.SERVER_SIGNING_PUBLIC_KEY_SPKI_HEX:');
console.log(publicSpkiHex);
