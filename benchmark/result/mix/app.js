/* ==========================================================================
   LumaBoard dashboard — vanilla JavaScript (charts + small interactions)
   ========================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------
     Revenue overview — grouped bar chart (SVG)
  --------------------------------------------------------------- */
  function renderRevenueChart() {
    var el = document.getElementById('revenueChart');
    if (!el) return;

    var data = [
      { day: 'Mon', prev: 78,  curr: 117 },
      { day: 'Tue', prev: 106, curr: 147 },
      { day: 'Wed', prev: 93,  curr: 130 },
      { day: 'Thu', prev: 132, curr: 177 },
      { day: 'Fri', prev: 117, curr: 153 },
      { day: 'Sat', prev: 151, curr: 197 },
      { day: 'Sun', prev: 133, curr: 168 }
    ];

    var W = 700;
    var H = 250;
    var padX = 10;
    var plotTop = 10;
    var plotBottom = 34;
    var plotH = H - plotTop - plotBottom; // 206
    var maxVal = 200;
    var gridLines = 5;

    var plotW = W - padX * 2;
    var groupW = plotW / data.length;
    var barW = 18;
    var barGap = 6;

    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Revenue overview bar chart">';

    // Horizontal grid lines (lowest one is the baseline)
    for (var g = 0; g < gridLines; g++) {
      var gy = plotTop + (plotH / (gridLines - 1)) * g;
      s += '<line x1="' + padX + '" y1="' + gy + '" x2="' + (W - padX) + '" y2="' + gy + '" stroke="#E8ECF3" stroke-width="1"/>';
    }

    data.forEach(function (d, i) {
      var cx = padX + groupW * i + groupW / 2;
      var x1 = cx - barGap / 2 - barW;
      var x2 = cx + barGap / 2;

      var h1 = Math.round((d.prev / maxVal) * plotH);
      var h2 = Math.round((d.curr / maxVal) * plotH);
      var y1 = plotTop + plotH - h1;
      var y2 = plotTop + plotH - h2;

      s += '<rect x="' + x1 + '" y="' + y1 + '" width="' + barW + '" height="' + h1 + '" rx="4" fill="#DDD9FF"/>';
      s += '<rect x="' + x2 + '" y="' + y2 + '" width="' + barW + '" height="' + h2 + '" rx="4" fill="#6759E5"/>';
      s += '<text x="' + cx + '" y="' + (H - 10) + '" text-anchor="middle" font-size="11" fill="#9AA3BD">' + d.day + '</text>';
    });

    s += '</svg>';
    el.innerHTML = s;
  }

  /* ---------------------------------------------------------------
     Monthly target — donut progress (SVG)
  --------------------------------------------------------------- */
  function renderDonut() {
    var el = document.getElementById('targetDonut');
    if (!el) return;

    var size = 112;
    var stroke = 12;
    var r = (size - stroke) / 2; // 50
    var c = size / 2;
    var circumference = 2 * Math.PI * r;
    var pct = 0.74;
    var dash = (circumference * pct).toFixed(2);

    var svg =
      '<svg viewBox="0 0 ' + size + ' ' + size + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Monthly target progress 74%">' +
      '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="none" stroke="#EAE8F8" stroke-width="' + stroke + '"/>' +
      '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="none" stroke="#6557E8" stroke-width="' + stroke + '" stroke-linecap="round" stroke-dasharray="' + dash + ' ' + circumference.toFixed(2) + '" transform="rotate(-90 ' + c + ' ' + c + ')"/>' +
      '<text x="' + c + '" y="' + (c + 1) + '" text-anchor="middle" dominant-baseline="middle" font-size="22" font-weight="800" fill="#071A35">74%</text>' +
      '</svg>';

    el.innerHTML = svg;
  }

  /* ---------------------------------------------------------------
     "Last 7 days" dropdown
  --------------------------------------------------------------- */
  function initDropdown() {
    var dd = document.getElementById('rangeDropdown');
    if (!dd) return;

    var btn = dd.querySelector('.dropdown-btn');
    var label = dd.querySelector('.dropdown-label');
    var items = dd.querySelectorAll('.dropdown-menu li');

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      dd.classList.toggle('open');
    });

    document.addEventListener('click', function () {
      dd.classList.remove('open');
    });

    items.forEach(function (item) {
      item.addEventListener('click', function () {
        items.forEach(function (i) { i.classList.remove('selected'); });
        item.classList.add('selected');
        label.textContent = item.textContent;
        dd.classList.remove('open');
      });
    });
  }

  /* ---------------------------------------------------------------
     Sidebar navigation — active state
  --------------------------------------------------------------- */
  function initNav() {
    var items = document.querySelectorAll('.nav-item');
    items.forEach(function (item) {
      item.addEventListener('click', function (e) {
        e.preventDefault();
        items.forEach(function (i) { i.classList.remove('active'); });
        item.classList.add('active');
      });
    });
  }

  renderRevenueChart();
  renderDonut();
  initDropdown();
  initNav();
})();
