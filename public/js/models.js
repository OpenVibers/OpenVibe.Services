// /models (AI Exchange P8): the filters apply as they change, the compare bar counts what is picked, the price
// calculator works as you type (the same nano-dollar math as the server: each token class rounded up once), and
// the code samples can be copied. Every part works without this file.
(function () {
    'use strict';
    var NANO = 1000000000n;

    // Filters: a change applies at once; typing in the search waits for a pause.
    var filters = document.querySelector('[data-mx-filters]');
    if (filters) {
        var timer = 0;
        filters.addEventListener('change', function (e) { if (e.target.name !== 'q') filters.requestSubmit ? filters.requestSubmit() : filters.submit(); });
        var q = filters.querySelector('input[name="q"]');
        if (q) q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { filters.requestSubmit ? filters.requestSubmit() : filters.submit(); }, 450); });
    }

    // Compare: two to four.
    var picks = Array.prototype.slice.call(document.querySelectorAll('[data-mx-pick]'));
    var said = document.querySelector('[data-mx-picked]');
    function count() {
        var chosen = picks.filter(function (p) { return p.checked; });
        picks.forEach(function (p) { p.disabled = !p.checked && chosen.length >= 4; });
        if (!said) return;
        var bar = said.closest('.mx-compare-bar');
        said.textContent = chosen.length === 0 ? 'Pick two to four models to compare them.' : chosen.length === 1 ? '1 picked: pick one more.' : chosen.length + ' picked.';
        if (bar) bar.classList.toggle('is-ready', chosen.length >= 2);
    }
    picks.forEach(function (p) { p.addEventListener('change', count); });
    count();

    // The calculator.
    function usd(n) {
        var whole = n / NANO;
        var frac = (n % NANO).toString().padStart(9, '0');
        var digits;
        if (whole >= 1n) digits = 2;
        else { var lead = frac.search(/[1-9]/); digits = lead < 0 ? 2 : Math.min(9, Math.max(2, lead + 3)); }
        var shown = frac.slice(0, digits).replace(/0+$/, '');
        if (whole >= 1n || shown.length < 2) shown = frac.slice(0, 2);
        return '$' + whole.toLocaleString('en-US') + '.' + shown;
    }
    var calc = document.querySelector('[data-mx-calc]');
    if (calc && typeof BigInt === 'function') {
        var rates = {};
        try { rates = JSON.parse(calc.getAttribute('data-rates') || '{}'); } catch (e) { rates = {}; }
        var big = function (v) { return /^[0-9]{1,19}$/.test(String(v)) ? BigInt(String(v)) : 0n; };
        var work = function () {
            var total = big(rates.per_request);
            ['input', 'cached_read', 'cache_write', 'output'].forEach(function (c) {
                var field = calc.querySelector('input[name="' + c + '"]');
                var t = field ? BigInt(Math.max(0, Math.min(10000000, Math.floor(Number(field.value) || 0)))) : 0n;
                if (t > 0n) total += (t * big(rates[c]) + 999999n) / 1000000n;
            });
            calc.querySelector('[data-mx-one]').textContent = usd(total);
            calc.querySelector('[data-mx-k]').textContent = usd(total * 1000n);
            calc.querySelector('[data-mx-m]').textContent = usd(total * 1000000n);
        };
        calc.addEventListener('input', work);
        var go = calc.querySelector('[data-mx-calc-submit]');
        if (go) go.hidden = true;
    }

    // Copy.
    document.querySelectorAll('[data-mx-copy]').forEach(function (btn) {
        var target = document.querySelector(btn.getAttribute('data-mx-copy'));
        if (!target || !navigator.clipboard) return;
        var label = btn.textContent;
        btn.hidden = false;
        btn.addEventListener('click', function () {
            navigator.clipboard.writeText(target.textContent || '').then(function () {
                btn.textContent = 'Copied';
                setTimeout(function () { btn.textContent = label; }, 1600);
            }, function () {});
        });
    });
})();
