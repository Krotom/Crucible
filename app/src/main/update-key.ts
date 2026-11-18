// The public key that signed releases must verify against (Ed25519, PEM). Empty: releases are checked against their SHA256SUMS.txt only.
// Make a key pair with `npm run update-keys`: it fills this in and writes the private key to app/update-private-key.pem (not committed).
export const UPDATE_PUBLIC_KEY = ''
