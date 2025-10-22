import { toRadians, roundTo as roundToNumber, floorTo as floorToNumber, lerp as lerpNumber, } from "../common/number";
/**
 * Math class for Vector2's
 * @example Add two Vector2's
 * ```ts
 * const a: Vector2 = { x: 100, y: 100 };
 * const b: Vector2 = { x: 50, y: 50 };
 * const c = Math2.add(a, b);
 * ```
 */
export class Math2 {
    /**
     * @summary magnitude is used here to not conflict with native length property
     * @returns The squared length of vector `p`
     */
    static magnitudeSquared(p) {
        return p.x * p.x + p.y * p.y;
    }
    /**
     * @summary magnitude is used here to not conflict with native length property
     * @returns The length of vector `p`
     */
    static magnitude(p) {
        const dist = Math.sqrt(this.magnitudeSquared(p));
        if (isNaN(dist)) {
            return 0;
        }
        return dist;
    }
    /**
     * @returns `p` normalized, if length of `p` is 0 `{x: 0, y: 0}` is returned
     */
    static normalize(p) {
        const l = this.magnitude(p);
        if (l === 0) {
            return { x: 0, y: 0 };
        }
        return this.divide(p, l);
    }
    /**
     * @returns The dot product between `a` and `b`
     */
    static dot(a, b) {
        return a.x * b.x + a.y * b.y;
    }
    /**
     * @returns `a` minus `b`
     */
    static subtract(a, b) {
        if (typeof b === "number") {
            return { x: a.x - b, y: a.y - b };
        }
        else {
            return { x: a.x - b.x, y: a.y - b.y };
        }
    }
    /**
     * @returns `a` plus `b`
     */
    static add(a, b) {
        if (typeof b === "number") {
            return { x: a.x + b, y: a.y + b };
        }
        else {
            return { x: a.x + b.x, y: a.y + b.y };
        }
    }
    /**
     * @returns `a` multiplied by `b`
     */
    static multiply(a, b) {
        if (typeof b === "number") {
            return { x: a.x * b, y: a.y * b };
        }
        else {
            return { x: a.x * b.x, y: a.y * b.y };
        }
    }
    /**
     * @returns `a` divided by `b`
     */
    static divide(a, b) {
        if (typeof b === "number") {
            return { x: a.x / b, y: a.y / b };
        }
        else {
            return { x: a.x / b.x, y: a.y / b.y };
        }
    }
    /**
     * Rotates a point around a given origin by an angle in degrees
     * @param point Point to rotate
     * @param origin Origin of the rotation
     * @param angle Angle of rotation in degrees
     * @returns Rotated point
     */
    static rotate(point, origin, angle) {
        const cos = Math.cos(toRadians(angle));
        const sin = Math.sin(toRadians(angle));
        const dif = this.subtract(point, origin);
        return {
            x: origin.x + cos * dif.x - sin * dif.y,
            y: origin.y + sin * dif.x + cos * dif.y,
        };
    }
    /**
     * @returns The min of `a` and `b`
     */
    static min(a, b) {
        if (typeof b === "number") {
            return { x: Math.min(a.x, b), y: Math.min(a.y, b) };
        }
        else {
            return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
        }
    }
    /**
     * @returns The component wise minimum of `a`
     */
    static componentMin(a) {
        return a.x < a.y ? a.x : a.y;
    }
    /**
     * @returns The max of `a` and `b`
     */
    static max(a, b) {
        if (typeof b === "number") {
            return { x: Math.max(a.x, b), y: Math.max(a.y, b) };
        }
        else {
            return { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
        }
    }
    /**
     * @returns The component wise maximum of `a`
     */
    static componentMax(a) {
        return a.x > a.y ? a.x : a.y;
    }
    /**
     * Rounds `p` to the nearest value of `to`
     */
    static roundTo(p, to) {
        return {
            x: roundToNumber(p.x, to.x),
            y: roundToNumber(p.y, to.y),
        };
    }
    /**
     * Floors `p` to the nearest value of `to`
     */
    static floorTo(p, to) {
        return {
            x: floorToNumber(p.x, to.x),
            y: floorToNumber(p.y, to.y),
        };
    }
    /**
     * @returns The component wise sign of `a`
     */
    static sign(a) {
        return { x: Math.sign(a.x), y: Math.sign(a.y) };
    }
    /**
     * @returns The component wise absolute of `a`
     */
    static abs(a) {
        return { x: Math.abs(a.x), y: Math.abs(a.y) };
    }
    /**
     * @returns `a` to the power of `b`
     */
    static pow(a, b) {
        if (typeof b === "number") {
            return { x: Math.pow(a.x, b), y: Math.pow(a.y, b) };
        }
        else {
            return { x: Math.pow(a.x, b.x), y: Math.pow(a.y, b.y) };
        }
    }
    /**
     * Clamps `a` between `min` and `max`
     */
    static clamp(a, min, max) {
        return {
            x: Math.min(Math.max(a.x, min), max),
            y: Math.min(Math.max(a.y, min), max),
        };
    }
    /**
     * Calculates an axis-aligned bounding box around an array of point
     */
    static boundingBox(points) {
        let minX = Number.MAX_SAFE_INTEGER;
        let maxX = Number.MIN_SAFE_INTEGER;
        let minY = Number.MAX_SAFE_INTEGER;
        let maxY = Number.MIN_SAFE_INTEGER;
        for (let point of points) {
            minX = point.x < minX ? point.x : minX;
            maxX = point.x > maxX ? point.x : maxX;
            minY = point.y < minY ? point.y : minY;
            maxY = point.y > maxY ? point.y : maxY;
        }
        let width = maxX - minX;
        let height = maxY - minY;
        let center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
        return {
            min: { x: minX, y: minY },
            max: { x: maxX, y: maxY },
            width,
            height,
            center,
        };
    }
    /**
     * Checks to see if a point is in a polygon using ray casting
     * See more at {@link https://en.wikipedia.org/wiki/Point_in_polygon#Ray_casting_algorithm}
     * and {@link https://stackoverflow.com/questions/217578/how-can-i-determine-whether-a-2d-point-is-within-a-polygon/2922778}
     */
    static pointInPolygon(p, points) {
        const bounds = this.boundingBox(points);
        if (p.x < bounds.min.x ||
            p.x > bounds.max.x ||
            p.y < bounds.min.y ||
            p.y > bounds.max.y) {
            return false;
        }
        let isInside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const a = points[i].y > p.y;
            const b = points[j].y > p.y;
            if (a !== b &&
                p.x <
                    ((points[j].x - points[i].x) * (p.y - points[i].y)) /
                        (points[j].y - points[i].y) +
                        points[i].x) {
                isInside = !isInside;
            }
        }
        return isInside;
    }
    /**
     * @returns True if the distance between `a` and `b` is under `threshold`
     */
    static compare(a, b, threshold) {
        return this.magnitudeSquared(this.subtract(a, b)) < threshold * threshold;
    }
    /**
     * @returns The distance between two vectors
     */
    static distance(a, b) {
        return this.magnitude(this.subtract(a, b));
    }
    /**
     * Linear interpolate between `a` and `b` by `alpha`
     */
    static lerp(a, b, alpha) {
        return { x: lerpNumber(a.x, b.x, alpha), y: lerpNumber(a.y, b.y, alpha) };
    }
    /**
     * @returns The centroid of the given points
     */
    static centroid(points) {
        let center = { x: 0, y: 0 };
        for (let point of points) {
            center.x += point.x;
            center.y += point.y;
        }
        if (points.length > 0) {
            center = { x: center.x / points.length, y: center.y / points.length };
        }
        return center;
    }
}
