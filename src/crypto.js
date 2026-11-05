import crypto from "node:crypto";

/**
 * "Sealed" tokens: AES-256-GCM encrypted + authenticated JSON blobs with an expiry.
 * Used for OAuth access/refresh tokens, authorization codes, state and client ids, so the server
 * needs no database and never stores a GitHub token on disk. Each purpose gets its own key
 * (HKDF from the master key) and is bound as AAD, so a token of one kind can never be used as another.
 */
export function makeSealer(masterKeyBase64) {
  const master = Buffer.from(masterKeyBase64 || "", "base64");
  if (master.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 encoded. Generate one with: openssl rand -base64 32");
  }
  const keys = new Map();
  const keyFor = (purpose) => {
    if (!keys.has(purpose)) {
      keys.set(purpose, Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), `github-mcp:${purpose}`, 32)));
    }
    return keys.get(purpose);
  };

  function seal(purpose, payload, ttlSeconds) {
    const iv = crypto.randomBytes(12);
    const body = JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds });
    const cipher = crypto.createCipheriv("aes-256-gcm", keyFor(purpose), iv);
    cipher.setAAD(Buffer.from(purpose));
    const ct = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]).toString("base64url");
  }

  function unseal(purpose, token) {
    try {
      const buf = Buffer.from(String(token || ""), "base64url");
      if (buf.length < 30 || buf[0] !== 1) return null;
      const decipher = crypto.createDecipheriv("aes-256-gcm", keyFor(purpose), buf.subarray(1, 13));
      decipher.setAAD(Buffer.from(purpose));
      decipher.setAuthTag(buf.subarray(13, 29));
      const plain = Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]).toString("utf8");
      const obj = JSON.parse(plain);
      if (typeof obj.exp !== "number" || obj.exp < Date.now() / 1000) return null;
      return obj;
    } catch {
      return null;
    }
  }

  return { seal, unseal };
}
