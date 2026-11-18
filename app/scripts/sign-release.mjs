// Signs a SHA256SUMS.txt for a release: node scripts/sign-release.mjs <SHA256SUMS.txt>   (the private key comes from the UPDATE_SIGNING_KEY environment variable)
// Writes <file>.sig (base64 Ed25519). Installed apps check it against the public key in src/main/update-key.ts.
import { createPrivateKey, sign } from 'node:crypto'
import fs from 'node:fs'

const file = process.argv[2]
const pem = process.env.UPDATE_SIGNING_KEY
if (!file || !pem) { console.error('usage: UPDATE_SIGNING_KEY=<pem> node scripts/sign-release.mjs <file>'); process.exit(2) }
fs.writeFileSync(`${file}.sig`, sign(null, fs.readFileSync(file), createPrivateKey(pem)).toString('base64') + '\n')
console.log(`signed ${file}`)
