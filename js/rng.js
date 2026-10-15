// Seeded randomness: the same seed always choreographs the same fight.

export function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const range = (r, a, b) => a + (b - a) * r();
export const pick = (r, list) => list[Math.floor(r() * list.length) % list.length];

/** entries: [[value, weight], ...] */
export function weighted(r, entries) {
    let sum = 0;
    for (const [, w] of entries) sum += w;
    let x = r() * sum;
    for (const [v, w] of entries) {
        x -= w;
        if (x <= 0) return v;
    }
    return entries[entries.length - 1][0];
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const smooth = (u) => u * u * (3 - 2 * u);
export function lerpAngle(a, b, u) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * u;
}
