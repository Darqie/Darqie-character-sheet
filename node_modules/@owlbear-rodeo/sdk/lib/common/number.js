export function roundTo(x, to) {
    return Math.round(x / to) * to;
}
export function floorTo(x, to) {
    return Math.floor(x / to) * to;
}
export function toRadians(angle) {
    return angle * (Math.PI / 180);
}
export function toDegrees(angle) {
    return angle * (180 / Math.PI);
}
export function lerp(from, to, alpha) {
    return from * (1 - alpha) + to * alpha;
}
