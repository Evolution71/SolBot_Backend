import { encryptSecret, decryptSecret } from "../utils/encryption";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a string", () => {
    const secret = "super-secret-value";
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted).toString("utf8")).toBe(secret);
  });

  it("round-trips raw bytes (e.g. a Solana keypair secret key)", () => {
    const bytes = new Uint8Array(64).map((_, i) => i);
    const encrypted = encryptSecret(bytes);
    const decrypted = decryptSecret(encrypted);
    expect(Uint8Array.from(decrypted)).toEqual(bytes);
  });

  it("produces different ciphertext for the same plaintext each time (random IV)", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a).not.toBe(b);
  });

  it("throws when the auth tag doesn't match (tampered ciphertext)", () => {
    const encrypted = encryptSecret("secret");
    const tamperedBuf = Buffer.from(encrypted, "base64");
    tamperedBuf[tamperedBuf.length - 1] ^= 0xff; // flip a byte in the ciphertext
    const tampered = tamperedBuf.toString("base64");

    expect(() => decryptSecret(tampered)).toThrow();
  });
});
