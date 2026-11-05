/* Soft translucent Holder Flow bubbles. Chart data still owns the radius. */
(function () {
  function paintSoftBubble(ctx, x, y, r, up, hot) {
    const rgb = up ? "46,255,168" : "255,92,108";
    const haloR = r + Math.min(16, 5 + r * 0.28);
    const halo = ctx.createRadialGradient(x, y, r * 0.2, x, y, haloR);
    halo.addColorStop(0, `rgba(${rgb},${hot ? 0.34 : 0.20})`);
    halo.addColorStop(0.55, `rgba(${rgb},0.06)`);
    halo.addColorStop(1, `rgba(${rgb},0)`);
    ctx.beginPath();
    ctx.arc(x, y, haloR, 0, Math.PI * 2);
    ctx.fillStyle = halo;
    ctx.fill();

    const body = ctx.createRadialGradient(x, y, r * 0.02, x, y, r);
    body.addColorStop(0, `rgba(${rgb},${hot ? 0.46 : 0.34})`);
    body.addColorStop(0.55, `rgba(${rgb},0.22)`);
    body.addColorStop(1, `rgba(${rgb},0.07)`);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.lineWidth = hot ? 1.45 : 1;
    ctx.strokeStyle = up ? "rgba(214,255,236,.55)" : "rgba(255,206,210,.55)";
    ctx.stroke();
  }

  function strokeFlowLine(ctx, pts) {
    if (!pts || pts.length < 2) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      ctx.bezierCurveTo(
        p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
        p2.x, p2.y
      );
    }
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(248,250,252,.96)";
    ctx.lineWidth = 1.7;
    ctx.shadowColor = "rgba(0,0,0,.65)";
    ctx.shadowBlur = 2;
    ctx.stroke();
    ctx.restore();
  }

  function flowRadius(abs, maxAbs, maxR) {
    const span = Math.max(0, maxR - 5);
    return 5 + Math.pow(Math.abs(abs) / Math.max(maxAbs, 1e-12), 0.62) * span;
  }

  window.paintSoftBubble = paintSoftBubble;
  window.strokeFlowLine = strokeFlowLine;
  window.flowRadius = flowRadius;
})();
