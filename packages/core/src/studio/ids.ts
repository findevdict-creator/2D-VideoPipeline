import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * A short id that sorts by creation time: 9 characters of time, 5 of randomness.
 * Scene folders, database rows and URLs all use these, so reordering a scene
 * never renames anything.
 */
export function newId(prefix: string, now = Date.now()): string {
  let t = Math.floor(now);
  let time = "";
  for (let i = 0; i < 9; i++) {
    time = ALPHABET[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(5);
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % 32]!;
  return `${prefix}_${time}${rand}`;
}

export const nowIso = () => new Date().toISOString();
