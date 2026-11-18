// Makes the key pair that signs releases: node scripts/update-keys.mjs   (npm run update-keys)
//   - the public key goes into src/main/update-key.ts (commit it: the app checks every update against it)
//   - the private key goes to app/update-private-key.pem (never commit it; it is in .gitignore) and is what the release workflow signs with
// Then store the private key as the repository secret UPDATE_SIGNING_KEY:   gh secret set UPDATE_SIGNING_KEY < app/update-private-key.pem
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const keyFile = path.join(app, 'src', 'main', 'update-key.ts')
const priv = path.join(app, 'update-private-key.pem')
if (fs.existsSync(priv) && !process.argv.includes('--force')) { console.error('update-private-key.pem exists already: a new key would make every installed copy refuse your next release. Use --force only to replace it on purpose.'); process.exit(1) }
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim()
fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 })
const src = fs.readFileSync(keyFile, 'utf8').replace(/export const UPDATE_PUBLIC_KEY = [\s\S]*$/, `export const UPDATE_PUBLIC_KEY = \`${pub}\`\n`)
fs.writeFileSync(keyFile, src)
console.log(`public key written to ${path.relative(process.cwd(), keyFile)} (commit it)\nprivate key written to ${path.relative(process.cwd(), priv)} (do not commit it)\n\nstore the private key for the release workflow:\n  gh secret set UPDATE_SIGNING_KEY < app/update-private-key.pem`)
