import { readFile, writeFile } from 'node:fs/promises';
import { createHash, sign, createPrivateKey } from 'node:crypto';
// The private key stays outside the checkout. This command never uploads artifacts.
const [archive, keyFile, url, version, output] = process.argv.slice(2);
if (!archive || !keyFile || !url || !/^\d+\.\d+\.\d+$/.test(version || '') || !output) throw new Error('Usage: node scripts/sign-release.mjs archive.zip private-key.pem https://host/archive.zip version manifest.json');
if (new URL(url).protocol !== 'https:') throw new Error('HTTPS_REQUIRED');
const bytes = await readFile(archive), key = createPrivateKey(await readFile(keyFile));
if (key.asymmetricKeyType !== 'ed25519') throw new Error('ED25519_REQUIRED');
const payload = JSON.stringify({ schemaVersion: 1, version, url, bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() });
await writeFile(output, JSON.stringify({ payload, signature: sign(null, Buffer.from(payload), key).toString('base64') }, null, 2));
console.log('Signed manifest created. No artifacts were published.');
