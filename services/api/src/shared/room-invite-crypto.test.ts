import { describe, expect, test } from "bun:test";
import { createNodeRoomInviteCrypto } from "./room-invite-crypto";

describe("room invitation crypto", () => {
  test("creates unique 256-bit base64url capability tokens", () => {
    const inviteCrypto = createNodeRoomInviteCrypto();
    const tokens = Array.from({ length: 128 }, () => inviteCrypto.createToken());

    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) {
      expect(token).toMatch(/^inv_[A-Za-z0-9_-]{43}$/u);
    }
  });

  test("produces a 32-byte SHA-256 digest", () => {
    const inviteCrypto = createNodeRoomInviteCrypto();
    const digest = inviteCrypto.digest("inv_example");

    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.byteLength).toBe(32);
    expect(Buffer.from(digest).toString("hex")).toBe(
      "bbb0c3f2bc8fdfc377f138fcf9c6aba23ba198f3ebf8581a2b57097b7807d980",
    );
  });

  test("accepts equal digests and rejects unequal digests", () => {
    const inviteCrypto = createNodeRoomInviteCrypto();
    const first = inviteCrypto.digest("inv_same");
    const second = inviteCrypto.digest("inv_same");
    const different = inviteCrypto.digest("inv_different");

    expect(inviteCrypto.equals(first, second)).toBe(true);
    expect(inviteCrypto.equals(first, different)).toBe(false);
  });

  test("safely rejects values with different digest lengths", () => {
    const inviteCrypto = createNodeRoomInviteCrypto();

    expect(inviteCrypto.equals(new Uint8Array(32), new Uint8Array(31))).toBe(false);
  });
});
