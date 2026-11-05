/* Shared Chart.js polish: smoother lines, soft depth, quiet axes, glass tooltips.
   Loaded after chart.umd.js. Does not change dataset values or scale wiring. */
(function () {
  if (!window.Chart) return;
  const C = Chart;
  const D = C.defaults;
  D.color = "#94a3b8";
  D.font.family = "Arial, Helvetica, sans-serif";
  D.elements.line.tension = 0.38;
  D.elements.line.borderWidth = 1.7;
  D.elements.line.borderCapStyle = "round";
  D.elements.line.borderJoinStyle = "round";
  D.elements.point.radius = 0;
  D.elements.point.hoverRadius = 4;
  D.elements.point.hitRadius = 8;
  D.elements.point.hoverBorderWidth = 2;
  D.elements.bar.borderRadius = 3;
  D.elements.bar.borderSkipped = false;
  const tip = D.plugins.tooltip;
  tip.backgroundColor = "rgba(8,12,16,.9)";
  tip.borderColor = "rgba(125,211,252,.38)";
  tip.borderWidth = 1;
  tip.cornerRadius = 12;
  tip.padding = 11;
  tip.titleColor = "#f8fafc";
  tip.bodyColor = "#cbd5e1";
  tip.footerColor = "#94a3b8";
  tip.caretSize = 6;
  tip.boxPadding = 4;
  tip.usePointStyle = true;
  D.plugins.legend.labels.color = "#cbd5e1";
  D.plugins.legend.labels.boxWidth = 8;
  D.plugins.legend.labels.boxHeight = 8;
  D.plugins.legend.labels.usePointStyle = true;
  D.plugins.legend.labels.pointStyle = "circle";
  D.scale.grid.color = "rgba(148,163,184,.09)";
  D.scale.grid.drawTicks = false;
  D.scale.border.display = false;
  D.scale.ticks.color = "#94a3b8";

  function rgb(c) {
    if (!c || typeof c !== "string") return null;
    const s = c.trim();
    if (s[0] === "#") {
      let h = s.slice(1);
      if (h.length === 3) h = h.split("").map(x => x + x).join("");
      if (h.length < 6) return null;
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)].join(",");
    }
    const m = s.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    return m ? `${m[1]},${m[2]},${m[3]}` : null;
  }

  C.register({
    id: "pulseDepth",
    beforeUpdate(chart) {
      chart.data.datasets.forEach(ds => {
        const type = ds.type || chart.config.type;
        if (type === "line" || type === "radar") {
          if (ds.tension == null || ds.tension < 0.32) ds.tension = 0.38;
          if (type === "line" && !ds.cubicInterpolationMode) ds.cubicInterpolationMode = "monotone";
          if (ds.pointRadius === 0 && ds.pointHoverRadius == null) {
            ds.pointHoverRadius = 4;
            ds.pointHoverBorderWidth = 2;
            ds.pointHoverBackgroundColor = "#030406";
            if (ds.pointHitRadius == null) ds.pointHitRadius = 10;
          }
          if (ds.borderCapStyle == null) ds.borderCapStyle = "round";
          if (ds.borderJoinStyle == null) ds.borderJoinStyle = "round";
        }
        if (type === "bar" && ds.borderRadius == null) ds.borderRadius = 3;
      });
    },
    beforeDatasetDraw(chart, args) {
      const ds = chart.data.datasets[args.index];
      const meta = args.meta;
      const type = meta.type || chart.config.type;
      const ctx = chart.ctx;
      const area = chart.chartArea;
      if (!ds || !area) return;
      if ((type === "line" || type === "radar") && ds.fill && typeof ds.backgroundColor === "string") {
        const base = rgb(typeof ds.borderColor === "string" ? ds.borderColor : ds.backgroundColor);
        if (base) {
          const g = ctx.createLinearGradient(0, area.top, 0, area.bottom);
          g.addColorStop(0, `rgba(${base},.40)`);
          g.addColorStop(0.55, `rgba(${base},.10)`);
          g.addColorStop(1, `rgba(${base},0)`);
          ds._pulseFill = ds.backgroundColor;
          ds.backgroundColor = g;
          if (meta.dataset && meta.dataset.options) meta.dataset.options.backgroundColor = g;
        }
      }
      ctx.save();
      ds._pulseShadow = true;
      if (type === "line" || type === "radar") {
        const base = rgb(typeof ds.borderColor === "string" ? ds.borderColor : "") || "0,255,136";
        ctx.shadowColor = `rgba(${base},.40)`;
        ctx.shadowBlur = type === "radar" ? 8 : 11;
        ctx.shadowOffsetY = type === "radar" ? 0 : 4;
      } else if (type === "bar") {
        ctx.shadowColor = "rgba(0,0,0,.45)";
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 3;
      }
    },
    afterDatasetDraw(chart, args) {
      const ds = chart.data.datasets[args.index];
      if (!ds || !ds._pulseShadow) return;
      chart.ctx.restore();
      ds._pulseShadow = false;
      if (ds._pulseFill) {
        ds.backgroundColor = ds._pulseFill;
        ds._pulseFill = null;
      }
    }
  });
})();
