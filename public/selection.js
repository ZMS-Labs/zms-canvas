"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PENECHO_SELECTION = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  function clipPoint(point, limit) {
    return { x: Math.max(0, Math.min(limit, point.x)), y: Math.max(0, Math.min(limit, point.y)) };
  }

  function polygonBounds(points, limit) {
    if (!points.length) return null;
    let left = limit,
      top = limit,
      right = 0,
      bottom = 0;
    for (const point of points) {
      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
    left = Math.max(0, Math.floor(left));
    top = Math.max(0, Math.floor(top));
    right = Math.min(limit, Math.ceil(right));
    bottom = Math.min(limit, Math.ceil(bottom));
    return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
  }

  function pathLength(points, scale = 1) {
    let length = 0;
    for (let index = 1; index < points.length; index++) length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y) * scale;
    return length;
  }

  function shouldAddPoint(points, point, minimumDistance) {
    const last = points.at(-1);
    return !last || Math.hypot(point.x - last.x, point.y - last.y) >= minimumDistance;
  }

  function pointInPolygon(point, polygon) {
    let inside = false;
    for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
      const a = polygon[current],
        b = polygon[previous],
        crosses = a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function unionBox(current, next) {
    if (!current) return { ...next };
    const x = Math.min(current.x, next.x),
      y = Math.min(current.y, next.y),
      right = Math.max(current.x + current.w, next.x + next.w),
      bottom = Math.max(current.y + current.h, next.y + next.h);
    return { x, y, w: right - x, h: bottom - y };
  }

  function moveBox(box, dx, dy, limit) {
    return {
      ...box,
      x: Math.max(0, Math.min(limit - box.w, box.x + dx)),
      y: Math.max(0, Math.min(limit - box.h, box.y + dy)),
    };
  }

  function resizeBox(box, point, minimum, limit) {
    const maximumScale = Math.max(Number.EPSILON, Math.min((limit - box.x) / box.w, (limit - box.y) / box.h)),
      minimumScale = Math.min(maximumScale, Math.max(minimum / box.w, minimum / box.h)),
      requestedScale = Math.max((point.x - box.x) / box.w, (point.y - box.y) / box.h),
      scale = Math.max(minimumScale, Math.min(maximumScale, requestedScale));
    return { ...box, w: box.w * scale, h: box.h * scale };
  }

  function mapFragment(fragment, sourceBox, targetBox) {
    const scaleX = targetBox.w / sourceBox.w,
      scaleY = targetBox.h / sourceBox.h;
    return {
      x: targetBox.x + (fragment.x - sourceBox.x) * scaleX,
      y: targetBox.y + (fragment.y - sourceBox.y) * scaleY,
      w: fragment.w * scaleX,
      h: fragment.h * scaleY,
    };
  }

  function controlPoints(box, size) {
    return {
      cancel: { x: box.x - size * 0.42, y: box.y - size * 0.42 },
      accept: { x: box.x + box.w + size * 0.42, y: box.y - size * 0.42 },
      move: { x: box.x + box.w / 2, y: box.y - size * 0.46 },
      resize: { x: box.x + box.w, y: box.y + box.h },
    };
  }

  function hitTest(box, point, size) {
    const controls = controlPoints(box, size),
      radius = Math.max(size * 0.8, 1);
    for (const action of ["cancel", "accept", "resize", "move"])
      if (Math.hypot(point.x - controls[action].x, point.y - controls[action].y) <= radius) return action;
    return point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h ? "move" : null;
  }

  return { clipPoint, polygonBounds, pathLength, shouldAddPoint, pointInPolygon, unionBox, moveBox, resizeBox, mapFragment, controlPoints, hitTest };
});
