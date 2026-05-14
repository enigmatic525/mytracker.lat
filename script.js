// ===== Pre-app setup (runs before the DOMContentLoaded handler) =====

// Surface uncaught JS errors on the page so failures are visible without DevTools.
window.addEventListener('error', (e) => {
    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;inset:0;z-index:99999;margin:0;background:#fff;color:#dc2626;font:12px/1.5 ui-monospace,monospace;padding:24px;white-space:pre-wrap;overflow:auto';
    box.textContent = 'JS ERROR\n\n' + ((e.error && e.error.stack) || e.message) + '\n\nat ' + e.filename + ':' + e.lineno + ':' + e.colno;
    (document.body || document.documentElement).appendChild(box);
});

// The service worker was removed; unregister any stale worker and purge its caches
// so the browser always loads files directly from the network.
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
    if (window.caches && caches.keys) {
        caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // ===== Constants =====
    const defaultGoal = 2000;
    const defaultMaintenance = 2500;
    const MIN_WEIGHT = 1;          // sanity bounds for input validation
    const MAX_WEIGHT = 1500;
    const MAX_CALORIES = 100000;
    const MAX_PRESETS = 4;
    const MAX_PRESET_NAME = 40;
    const STORAGE_KEY = 'calorieTrackerStateV2';
    const PRESETS_KEY = 'calorieTrackerPresets';

    // ===== State =====
    let state = {
        goal: defaultGoal,
        maintenance: defaultMaintenance,
        history: {},          // { 'YYYY-MM-DD': calories }
        weightHistory: {},    // { 'YYYY-MM-DD': weight }
        theme: 'light',       // 'light' | 'dark'
        unit: 'imperial'      // 'imperial' | 'metric'
    };

    let currentDateString = getTodayDateString();
    let viewingDateString = currentDateString;

    let presets = [
        { id: 1, name: 'Hamburger', calories: 350 },
        { id: 2, name: 'Medium Fries', calories: 400 },
        { id: 3, name: 'Chips', calories: 200 },
        { id: 4, name: 'Boba Tea', calories: 500 }
    ];

    // Weight-tab state shared between the renderer and the chart interaction handlers.
    let currentWeightRange = 'month';
    let activeDotDateStr = null;
    let currentSvgPts = [];

    // ===== DOM references =====
    const dateEl = document.getElementById('current-date');
    const dayLabelEl = document.getElementById('day-label');
    const dateTitlesEl = document.getElementById('date-titles');
    const datePickerEl = document.getElementById('date-picker');
    const caloriesCurrentEl = document.getElementById('calories-current');
    const caloriesLeftEl = document.getElementById('calories-left');
    const metricGoalEl = document.getElementById('metric-goal');
    const metricMaintEl = document.getElementById('metric-maint');
    const metricGoalValEl = document.getElementById('metric-goal-val');
    const metricMaintValEl = document.getElementById('metric-maint-val');

    const btnPrevDay = document.getElementById('btn-prev-day');
    const btnNextDay = document.getElementById('btn-next-day');

    const btnMinus100 = document.getElementById('btn-minus-100');
    const btnMinus50 = document.getElementById('btn-minus-50');
    const btnPlus50 = document.getElementById('btn-plus-50');
    const btnPlus100 = document.getElementById('btn-plus-100');
    const progressBarFill = document.getElementById('progress-bar-fill');
    const presetsGrid = document.getElementById('presets-grid');

    const chartBarsEl = document.getElementById('chart-bars');
    const chartGoalLineEl = document.getElementById('chart-goal-line');
    const chartMaintenanceLineEl = document.getElementById('chart-maintenance-line');
    const chartLabelsRowEl = document.getElementById('chart-labels-row');
    const weeklyDiffLabelEl = document.getElementById('weekly-difference-label');

    const caloriesModal = document.getElementById('calories-modal');
    const caloriesInput = document.getElementById('calories-input');
    const btnCancelCalories = document.getElementById('btn-cancel-calories');
    const btnSaveCalories = document.getElementById('btn-save-calories');

    const goalModal = document.getElementById('goal-modal');
    const btnCancelGoal = document.getElementById('btn-cancel-goal');
    const btnSaveGoal = document.getElementById('btn-save-goal');

    const maintModal = document.getElementById('maint-modal');
    const btnCancelMaint = document.getElementById('btn-cancel-maint');
    const btnSaveMaint = document.getElementById('btn-save-maint');

    const presetModal = document.getElementById('preset-modal');
    const presetNameInput = document.getElementById('preset-name-input');
    const presetCalInput = document.getElementById('preset-cal-input');
    const btnAddPreset = document.getElementById('btn-add-preset');
    const btnCancelPreset = document.getElementById('btn-cancel-preset');
    const btnSavePreset = document.getElementById('btn-save-preset');

    // ===== Init =====
    init();

    function init() {
        loadState();
        loadPresets();
        updateDateElements();
        updateUI();
        setupEventListeners();

        const tutorialOverlay = document.getElementById('tutorial-overlay');
        const btnTutorialClose = document.getElementById('btn-tutorial-close');
        if (tutorialOverlay && btnTutorialClose) {
            let seen = false;
            try { seen = !!localStorage.getItem('trackerTutorialSeen'); } catch (e) {}
            if (!seen) tutorialOverlay.classList.add('active');
            const closeTutorial = () => {
                tutorialOverlay.classList.remove('active');
                try { localStorage.setItem('trackerTutorialSeen', '1'); } catch (e) {}
            };
            btnTutorialClose.addEventListener('click', closeTutorial);
            tutorialOverlay.addEventListener('click', (e) => {
                if (e.target === tutorialOverlay) closeTutorial();
            });
        }
    }

    // ===== Date helpers =====
    function getDateString(d) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    function getTodayDateString() {
        return getDateString(new Date());
    }

    // ===== Persistence =====
    // localStorage is untrusted input: parse defensively and whitelist every field
    // so a corrupt or hand-edited blob can never inject unexpected state.
    function loadState() {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            try {
                const p = JSON.parse(saved);
                state = {
                    goal: typeof p.goal === 'number' ? p.goal : defaultGoal,
                    maintenance: typeof p.maintenance === 'number' ? p.maintenance : defaultMaintenance,
                    history: sanitizeNumberMap(p.history),
                    weightHistory: sanitizeNumberMap(p.weightHistory),
                    theme: p.theme === 'dark' ? 'dark' : 'light',
                    unit: p.unit === 'metric' ? 'metric' : 'imperial'
                };
            } catch (e) {
                // Corrupt storage — keep the safe defaults rather than crashing.
            }
        } else {
            // Migrate from the v1 storage format if present.
            const oldSaved = localStorage.getItem('calorieTrackerState');
            if (oldSaved) {
                try {
                    const old = JSON.parse(oldSaved);
                    if (typeof old.goal === 'number') state.goal = old.goal;
                    if (old.lastUpdated && typeof old.calories === 'number') {
                        state.history[old.lastUpdated] = old.calories;
                    }
                } catch (e) {}
            }
        }
        if (typeof state.history[currentDateString] !== 'number') {
            state.history[currentDateString] = 0;
        }
        applyThemeAndUnits();
    }

    // Keep only 'YYYY-MM-DD' -> finite-number pairs from an untrusted object.
    function sanitizeNumberMap(obj) {
        const out = {};
        if (obj && typeof obj === 'object') {
            Object.keys(obj).forEach((k) => {
                if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof obj[k] === 'number' && isFinite(obj[k])) {
                    out[k] = obj[k];
                }
            });
        }
        return out;
    }

    function saveState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {}
    }

    function loadPresets() {
        const savedPresets = localStorage.getItem(PRESETS_KEY);
        if (savedPresets) {
            try {
                const parsed = JSON.parse(savedPresets);
                if (Array.isArray(parsed)) {
                    presets = parsed
                        .filter((p) => p && typeof p.name === 'string' && typeof p.calories === 'number' && isFinite(p.calories))
                        .slice(0, MAX_PRESETS)
                        .map((p) => ({
                            id: typeof p.id === 'number' ? p.id : Date.now() + Math.random(),
                            name: p.name.slice(0, MAX_PRESET_NAME),
                            calories: p.calories
                        }));
                }
            } catch (e) {}
        }
        renderPresets();
    }

    function savePresets() {
        try {
            localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
        } catch (e) {}
        renderPresets();
    }

    // ===== Theme & units =====
    function applyThemeAndUnits() {
        document.body.className = `theme-${state.theme}`;
        const metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme) metaTheme.content = state.theme === 'dark' ? '#0b0b0d' : '#ffffff';

        document.querySelectorAll('.theme-mode-toggle').forEach((btn) => {
            const isActive = btn.getAttribute('data-mode') === state.theme;
            btn.classList.toggle('active', isActive);
            btn.classList.toggle('btn-primary', isActive);
            btn.classList.toggle('btn-secondary', !isActive);
        });
        document.querySelectorAll('.unit-toggle').forEach((btn) => {
            const isActive = btn.getAttribute('data-unit') === state.unit;
            btn.classList.toggle('active', isActive);
            btn.classList.toggle('btn-primary', isActive);
            btn.classList.toggle('btn-secondary', !isActive);
        });
    }

    // ===== Header / date =====
    function updateDateElements() {
        const d = new Date(viewingDateString + 'T12:00:00');
        dateEl.textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

        if (viewingDateString === currentDateString) {
            dayLabelEl.textContent = 'Today';
            btnNextDay.disabled = true;
        } else {
            const currentD = new Date(currentDateString + 'T12:00:00');
            const diffDays = Math.round((currentD.getTime() - d.getTime()) / 86400000);
            dayLabelEl.textContent = diffDays === 1 ? 'Yesterday' : `${diffDays} days ago`;
            btnNextDay.disabled = false;
        }
    }

    // ===== Calorie tab =====
    function updateUI() {
        const cals = state.history[viewingDateString] || 0;
        caloriesCurrentEl.textContent = cals;
        if (metricGoalValEl) metricGoalValEl.textContent = state.goal;
        if (metricMaintValEl) metricMaintValEl.textContent = state.maintenance;

        const diff = state.goal - cals;
        if (caloriesLeftEl) {
            caloriesLeftEl.textContent = diff >= 0 ? `${diff} remaining` : `${Math.abs(diff)} over`;
        }

        let percentage = (cals / state.goal) * 100;
        if (percentage > 100) percentage = 100;
        if (progressBarFill) {
            progressBarFill.style.width = `${percentage}%`;
            progressBarFill.style.background = cals > state.goal ? 'var(--danger)' : 'var(--accent-primary)';
        }

        // Easter egg: calorie overload
        if (cals > 10000) {
            triggerOverload();
        } else if (window.overloadInterval) {
            clearInterval(window.overloadInterval);
            window.overloadInterval = null;
            document.querySelectorAll('.overload-window').forEach((el) => el.remove());
        }

        renderChart();
    }

    function triggerOverload() {
        if (window.overloadInterval) return;
        window.overloadInterval = setInterval(() => {
            const cals = state.history[viewingDateString] || 0;
            if (cals <= 10000) {
                clearInterval(window.overloadInterval);
                window.overloadInterval = null;
                return;
            }
            if (document.querySelectorAll('.overload-window').length > 20) return;

            const win = document.createElement('div');
            win.className = 'overload-window';
            win.style.left = (Math.random() * 70) + '%';
            win.style.top = (Math.random() * 80) + '%';
            // Static markup only — no user data, no inline event handlers.
            win.innerHTML = `
                <div class="overload-header">
                    <span>&#9888; Error</span>
                    <span class="overload-close" role="button" tabindex="0">X</span>
                </div>
                <div class="overload-body">
                    <div style="font-size:32px; margin-bottom:8px;">&#9888;&#65039;</div>
                    <p style="color:#fff; font-size:14px; font-weight:bold; margin:0;">Notice: unknown file detected</p>
                    <p style="color:#fff; font-size:11px; font-weight:normal; margin-top:8px;">Device security may be compromised</p>
                    <button class="overload-btn">Scan now</button>
                </div>`;
            win.querySelectorAll('.overload-close, .overload-btn').forEach((b) => {
                b.addEventListener('click', () => win.remove());
            });
            document.body.appendChild(win);
        }, 120);
    }

    function renderChart() {
        chartBarsEl.innerHTML = '';
        if (chartLabelsRowEl) chartLabelsRowEl.innerHTML = '';

        const daysToShow = 7;
        const historyData = [];
        let weeklyDiff = 0;
        const viewD = new Date(viewingDateString + 'T12:00:00');
        let maxCals = Math.max(state.goal, state.maintenance);

        for (let i = daysToShow - 1; i >= 0; i--) {
            const tempD = new Date(viewD.getTime() - i * 86400000);
            const dStr = getDateString(tempD);
            const c = state.history[dStr] || 0;
            if (c > maxCals) maxCals = c;
            if (c > 0 && dStr < currentDateString) weeklyDiff += (c - state.maintenance);
            historyData.push({
                dateStr: dStr,
                cals: c,
                hasEntry: c > 0,
                label: tempD.toLocaleDateString('en-US', { weekday: 'narrow' })
            });
        }

        if (weeklyDiffLabelEl) {
            const calSign = weeklyDiff > 0 ? '+' : '';
            const divisor = state.unit === 'metric' ? 7700 : 3500;
            const unitName = state.unit === 'metric' ? 'kg' : 'lbs';
            const wt = (weeklyDiff / divisor).toFixed(1);
            const wtSign = weeklyDiff > 0 ? '+' : '';
            weeklyDiffLabelEl.textContent = `This week: ${calSign}${weeklyDiff} cal, ${wtSign}${wt} ${unitName}`;
        }

        // 50% headroom so bars and diff text never overlap the label.
        const chartMax = maxCals * 1.5;

        const goalPercent = Math.min((state.goal / chartMax) * 100, 100);
        chartGoalLineEl.style.bottom = `${goalPercent}%`;
        chartGoalLineEl.style.top = 'auto';

        if (chartMaintenanceLineEl) {
            const maintPercent = Math.min((state.maintenance / chartMax) * 100, 100);
            chartMaintenanceLineEl.style.bottom = `${maintPercent}%`;
            chartMaintenanceLineEl.style.top = 'auto';
        }

        historyData.forEach((item) => {
            const isViewingDay = item.dateStr === viewingDateString;
            const heightPercent = item.hasEntry ? Math.min((item.cals / chartMax) * 100, 100) : 0;

            const col = document.createElement('div');
            col.className = `chart-col ${isViewingDay ? 'active' : ''}`;

            const barWrapper = document.createElement('div');
            barWrapper.className = 'chart-bar-wrapper';

            const bar = document.createElement('div');
            bar.className = `chart-bar${isViewingDay ? ' active' : ''}`;
            bar.style.height = item.hasEntry ? `${Math.max(heightPercent, 2)}%` : '0%';
            bar.style.position = 'relative';

            if (item.hasEntry) {
                const diffEl = document.createElement('div');
                diffEl.className = 'bar-diff-text';
                const diffFromMaint = item.cals - state.maintenance;
                const sign = diffFromMaint > 0 ? '+' : '';
                diffEl.textContent = diffFromMaint === 0 ? '0' : `${sign}${diffFromMaint}`;
                bar.appendChild(diffEl);
            }

            barWrapper.appendChild(bar);
            col.appendChild(barWrapper);
            chartBarsEl.appendChild(col);

            if (chartLabelsRowEl) {
                const labelEl = document.createElement('div');
                labelEl.className = 'chart-label';
                if (isViewingDay) {
                    labelEl.style.color = 'var(--text-primary)';
                    labelEl.style.fontWeight = '500';
                }
                labelEl.textContent = item.label;
                chartLabelsRowEl.appendChild(labelEl);
            }
        });
    }

    function adjustCalories(amount) {
        let current = state.history[viewingDateString] || 0;
        current = Math.max(0, Math.min(MAX_CALORIES, current + amount));
        state.history[viewingDateString] = current;

        caloriesCurrentEl.style.transform = 'scale(1.1)';
        setTimeout(() => { caloriesCurrentEl.style.transform = 'scale(1)'; }, 150);

        saveState();
        updateUI();
    }

    function renderPresets() {
        presetsGrid.innerHTML = '';
        presets.forEach((preset) => {
            const card = document.createElement('div');
            card.className = 'preset-card';

            const info = document.createElement('div');
            info.className = 'preset-info';
            const nameEl = document.createElement('div');
            nameEl.className = 'preset-name';
            nameEl.textContent = preset.name; // textContent — never innerHTML for user data (XSS)
            const calEl = document.createElement('div');
            calEl.className = 'preset-cal';
            calEl.textContent = `${preset.calories > 0 ? '+' : ''}${preset.calories}`;
            info.appendChild(nameEl);
            info.appendChild(calEl);

            const delBtn = document.createElement('button');
            delBtn.className = 'preset-delete';
            delBtn.setAttribute('aria-label', 'Delete preset');
            // Static SVG markup, no user data.
            delBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';

            card.appendChild(info);
            card.appendChild(delBtn);

            card.addEventListener('click', (e) => {
                if (e.target.closest('.preset-delete')) return;
                adjustCalories(preset.calories);
            });
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                presets = presets.filter((p) => p.id !== preset.id);
                savePresets();
            });

            presetsGrid.appendChild(card);
        });
    }

    // ===== Navigation between days / dates =====
    function shiftDay(delta) {
        const d = new Date(viewingDateString + 'T12:00:00');
        d.setDate(d.getDate() + delta);
        const next = getDateString(d);
        if (next > currentDateString) return; // never navigate into the future
        viewingDateString = next;
        if (typeof state.history[viewingDateString] !== 'number') {
            state.history[viewingDateString] = 0;
        }
        updateDateElements();
        refreshActiveView();
    }

    function jumpToDate(dateStr) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
        if (dateStr > currentDateString) dateStr = currentDateString;
        viewingDateString = dateStr;
        if (typeof state.history[viewingDateString] !== 'number') {
            state.history[viewingDateString] = 0;
        }
        updateDateElements();
        refreshActiveView();
    }

    // Re-render whichever tab is currently visible. Day/date navigation must refresh
    // the weight tab too — previously it only refreshed the calorie tab, so weight
    // entries appeared "stuck" on the old day until you switched tabs.
    function refreshActiveView() {
        updateUI();
        const weightTab = document.getElementById('tab-weight');
        if (weightTab && weightTab.classList.contains('active')) {
            renderWeightTab();
            refreshWeightSheet();
        }
    }

    // ===== Weight tab =====
    // Least-squares slope (weight change per day) over entries within the last 30 days.
    // Time values are mean-centered before summing: raw day-numbers are ~20000, so
    // computing slope from n*Σt² - (Σt)² directly causes catastrophic cancellation.
    function computeWeightTrend() {
        const cutoff = new Date(currentDateString + 'T12:00:00').getTime() - 30 * 86400000;
        const pts = Object.keys(state.weightHistory)
            .filter((k) => new Date(k + 'T12:00:00').getTime() >= cutoff)
            .sort()
            .map((k) => ({ t: new Date(k + 'T12:00:00').getTime() / 86400000, w: state.weightHistory[k] }));
        if (pts.length < 3) return null;
        const n = pts.length;
        const meanT = pts.reduce((s, p) => s + p.t, 0) / n;
        const meanW = pts.reduce((s, p) => s + p.w, 0) / n;
        let num = 0;
        let den = 0;
        pts.forEach((p) => {
            const dt = p.t - meanT;
            num += dt * (p.w - meanW);
            den += dt * dt;
        });
        if (den === 0) return null;
        return { slopePerDay: num / den };
    }

    function straightPath(pts) {
        if (pts.length < 2) return '';
        return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
    }

    // Renders the +/- diff metric for a rolling window (e.g. 7-day, 30-day change).
    function renderWeightMetric(valId, unitId, windowDays, allWKeys, unitName) {
        const el = document.getElementById(valId);
        const unitEl = document.getElementById(unitId);
        if (!el) return;
        const cutoffStr = getDateString(new Date(new Date(currentDateString + 'T12:00:00').getTime() - windowDays * 86400000));
        const recent = allWKeys.filter((k) => k > cutoffStr);
        const older = allWKeys.filter((k) => k <= cutoffStr);
        if (recent.length > 0 && older.length > 0) {
            const diff = state.weightHistory[recent[recent.length - 1]] - state.weightHistory[older[older.length - 1]];
            el.textContent = `${diff > 0 ? '+' : ''}${diff.toFixed(1)}`;
            if (unitEl) unitEl.textContent = unitName;
        } else {
            el.textContent = '--';
            if (unitEl) unitEl.textContent = '';
        }
    }

    function renderWeightTab() {
        const svgEl = document.getElementById('weight-chart-svg');
        if (!svgEl) return;

        const emptyEl = document.getElementById('weight-chart-empty');
        const xAxisEl = document.getElementById('weight-x-axis');
        const yAxisEl = document.getElementById('weight-y-axis');
        const dotsEl = document.getElementById('weight-chart-dots');
        const pathLine = document.getElementById('weight-chart-line');
        const maLineEl = document.getElementById('weight-ma-line');
        const projLineEl = document.getElementById('weight-projection-line');
        const summaryEl = document.getElementById('weight-projection-summary');
        const unitName = state.unit === 'metric' ? 'kg' : 'lbs';

        const daysMap = { week: 7, month: 30, year: 365 };
        const days = daysMap[currentWeightRange] || 30;

        // Build the historical date range ending on the viewing date.
        const allSlots = [];
        const viewD = new Date(viewingDateString + 'T12:00:00');
        for (let i = days - 1; i >= 0; i--) {
            const tempD = new Date(viewD.getTime() - i * 86400000);
            const dStr = getDateString(tempD);
            allSlots.push({ slotIndex: days - 1 - i, date: tempD, dateStr: dStr, weight: state.weightHistory[dStr] || null });
        }

        // Trend projection: extend ~14 days into the future when a trend exists.
        const trend = computeWeightTrend();
        const allowProjection = trend && currentWeightRange !== 'year';
        let extraDays = 0;
        if (allowProjection) {
            // Modest forward window (~a quarter of the range) so the real data
            // still dominates the chart instead of being squeezed left.
            extraDays = Math.round(days / 4);
            for (let k = 1; k <= extraDays; k++) {
                const fD = new Date(viewD.getTime() + k * 86400000);
                allSlots.push({ slotIndex: days - 1 + k, date: fD, dateStr: getDateString(fD), weight: null, future: true });
            }
        }

        const dataPoints = allSlots.filter((s) => s.weight !== null);
        const allWKeys = Object.keys(state.weightHistory).sort();

        // Metrics row
        renderWeightMetric('weight-metric-week', 'weight-metric-week-unit', 7, allWKeys, unitName);
        renderWeightMetric('weight-metric-30d', 'weight-metric-30d-unit', 30, allWKeys, unitName);
        const metricLowEl = document.getElementById('weight-metric-low');
        const metricLowUnitEl = document.getElementById('weight-metric-low-unit');
        if (metricLowEl) {
            if (allWKeys.length > 0) {
                metricLowEl.textContent = Math.min(...allWKeys.map((k) => state.weightHistory[k])).toFixed(1);
                if (metricLowUnitEl) metricLowUnitEl.textContent = unitName;
            } else {
                metricLowEl.textContent = '--';
                if (metricLowUnitEl) metricLowUnitEl.textContent = '';
            }
        }

        // Projection summary: weekly rate + projected value 14 days out.
        if (summaryEl) {
            let txt = '';
            if (trend && allWKeys.length > 0) {
                const lastKey = allWKeys[allWKeys.length - 1];
                const lastEntryW = state.weightHistory[lastKey];
                const lastEntryT = new Date(lastKey + 'T12:00:00').getTime() / 86400000;
                const ratePerWeek = trend.slopePerDay * 7;
                const horizon = 14;
                const projected = lastEntryW + trend.slopePerDay * horizon;
                const projDate = new Date((lastEntryT + horizon) * 86400000);
                const fmt = (dt) => dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                if (Math.abs(ratePerWeek) < 0.05) {
                    txt = `Holding steady · about ${projected.toFixed(1)} ${unitName} through ${fmt(projDate)}`;
                } else {
                    const sign = ratePerWeek > 0 ? '+' : '';
                    txt = `${sign}${ratePerWeek.toFixed(1)} ${unitName}/week · projected ${projected.toFixed(1)} ${unitName} by ${fmt(projDate)}`;
                }
            }
            summaryEl.textContent = txt;
            summaryEl.style.display = txt ? '' : 'none';
        }

        // Reset chart elements. dotsEl also contains the persistent scrubber dot,
        // so clear only the data dots, not the whole container.
        if (xAxisEl) xAxisEl.innerHTML = '';
        if (yAxisEl) yAxisEl.innerHTML = '';
        if (dotsEl) dotsEl.querySelectorAll('.weight-dot').forEach((d) => d.remove());
        if (maLineEl) maLineEl.setAttribute('d', '');
        if (projLineEl) projLineEl.style.display = 'none';

        if (dataPoints.length < 2) {
            pathLine.setAttribute('d', '');
            if (emptyEl) emptyEl.style.display = 'flex';
            currentSvgPts = [];
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        // Y range with padding — include the projected endpoint so it stays on-canvas.
        let maxW = Math.max(...dataPoints.map((p) => p.weight));
        let minW = Math.min(...dataPoints.map((p) => p.weight));
        if (allowProjection && extraDays > 0) {
            const lastReal = dataPoints[dataPoints.length - 1];
            const projEnd = lastReal.weight + trend.slopePerDay * ((days - 1 + extraDays) - lastReal.slotIndex);
            maxW = Math.max(maxW, projEnd);
            minW = Math.min(minW, projEnd);
        }
        const yPad = Math.max((maxW - minW) * 0.2, 1);
        maxW += yPad;
        minW -= yPad;
        const yRange = maxW - minW;

        // Y-axis: 4 ticks, positioned by exact % so they line up with the SVG.
        if (yAxisEl) {
            for (let t = 0; t < 4; t++) {
                const val = maxW - (t / 3) * yRange;
                const lbl = document.createElement('div');
                lbl.style.top = `${(t / 3) * 100}%`;
                // Keep the top and bottom labels fully inside the plot box.
                if (t === 0) lbl.style.transform = 'translateY(0)';
                else if (t === 3) lbl.style.transform = 'translateY(-100%)';
                lbl.textContent = val.toFixed(1);
                yAxisEl.appendChild(lbl);
            }
        }

        // X-axis labels
        const xRange = Math.max(1, allSlots.length - 1);
        if (xAxisEl) {
            const labelCount = currentWeightRange === 'year' ? 12 : 7;
            for (let i = 0; i < labelCount; i++) {
                const slotIdx = Math.round((i / Math.max(1, labelCount - 1)) * xRange);
                const slot = allSlots[Math.min(slotIdx, allSlots.length - 1)];
                const lbl = document.createElement('div');
                lbl.className = 'chart-label';
                // Position at the slot's true x — must match how the dots are placed.
                lbl.style.left = `${(slotIdx / xRange) * 100}%`;
                lbl.textContent = currentWeightRange === 'year'
                    ? slot.date.toLocaleDateString('en-US', { month: 'short' })
                    : slot.date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
                xAxisEl.appendChild(lbl);
            }
        }

        // Plot. The SVG viewBox is a fixed 0-100 square (set in the HTML) and
        // stretches to the chart box; all coordinates below are in that 0-100 space.
        const svgPts = dataPoints.map((pt) => ({
            x: (pt.slotIndex / xRange) * 100,
            y: 100 - ((pt.weight - minW) / yRange) * 100,
            weight: pt.weight,
            dateStr: pt.dateStr,
            date: pt.date,
            slotIndex: pt.slotIndex
        }));
        currentSvgPts = svgPts;

        pathLine.setAttribute('d', straightPath(svgPts));

        // 7-day moving average
        if (maLineEl && svgPts.length >= 2) {
            const maPts = svgPts.map((pt) => {
                const ptTime = new Date(pt.dateStr + 'T12:00:00').getTime();
                const sevenBack = ptTime - 6 * 86400000;
                const win = svgPts.filter((p) => {
                    const d = new Date(p.dateStr + 'T12:00:00').getTime();
                    return d >= sevenBack && d <= ptTime;
                });
                const avg = win.reduce((s, p) => s + p.weight, 0) / win.length;
                return { x: pt.x, y: 100 - ((avg - minW) / yRange) * 100 };
            });
            maLineEl.setAttribute('d', straightPath(maPts));
        }

        // Projection line — extends the trend from the last real point forward.
        if (projLineEl && allowProjection && extraDays > 0 && svgPts.length >= 1) {
            const lastPt = svgPts[svgPts.length - 1];
            const horizonSlot = days - 1 + extraDays;
            const endWeight = lastPt.weight + trend.slopePerDay * (horizonSlot - lastPt.slotIndex);
            const endX = (horizonSlot / xRange) * 100;
            const endY = 100 - ((endWeight - minW) / yRange) * 100;
            projLineEl.setAttribute('d', `M${lastPt.x.toFixed(2)},${lastPt.y.toFixed(2)} L${endX.toFixed(2)},${endY.toFixed(2)}`);
            projLineEl.style.display = '';
        }

        // Data dots — HTML divs positioned by %, so they stay perfectly round
        // regardless of the chart's (wide, short) aspect ratio. Pointer events
        // are handled by the overlay layer on top.
        if (dotsEl) {
            svgPts.forEach((pt) => {
                const dot = document.createElement('div');
                dot.className = 'weight-dot';
                dot.style.left = `${pt.x}%`;
                dot.style.top = `${pt.y}%`;
                dotsEl.appendChild(dot);
            });
        }
    }

    // ===== Weight entry sheet (horizontal scrolling row of day cells) =====
    function buildWeightCell(dateStr) {
        const d = new Date(dateStr + 'T12:00:00');
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'weight-cell';
        cell.dataset.date = dateStr;
        if (dateStr === currentDateString) cell.classList.add('today');
        const w = state.weightHistory[dateStr];
        if (typeof w === 'number') cell.classList.add('filled');

        const dateLbl = document.createElement('span');
        dateLbl.className = 'weight-cell-date';
        dateLbl.textContent = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const valLbl = document.createElement('span');
        valLbl.className = 'weight-cell-val';
        valLbl.textContent = typeof w === 'number' ? w.toFixed(1) : '+';

        cell.appendChild(dateLbl);
        cell.appendChild(valLbl);
        return cell;
    }

    // Builds the initial cells, wires "extend into the past on scroll", and
    // delegates cell clicks to the entry modal. Runs once at startup.
    function setupWeightSheet() {
        const sheet = document.getElementById('weight-sheet');
        if (!sheet) return;
        const today = new Date(currentDateString + 'T12:00:00');
        let oldest = new Date(today.getTime() - 44 * 86400000); // start with ~6 weeks of history

        for (let t = oldest.getTime(); t <= today.getTime(); t += 86400000) {
            sheet.appendChild(buildWeightCell(getDateString(new Date(t))));
        }

        // The row "keeps extending": when scrolled near the left edge, prepend
        // another chunk of older days and bump scrollLeft by the width added so
        // the viewport stays put instead of jumping.
        let extending = false;
        sheet.addEventListener('scroll', () => {
            if (extending || sheet.scrollLeft > 80) return;
            extending = true;
            const prevWidth = sheet.scrollWidth;
            const frag = document.createDocumentFragment();
            for (let i = 30; i >= 1; i--) {
                frag.appendChild(buildWeightCell(getDateString(new Date(oldest.getTime() - i * 86400000))));
            }
            oldest = new Date(oldest.getTime() - 30 * 86400000);
            sheet.insertBefore(frag, sheet.firstChild);
            sheet.scrollLeft += sheet.scrollWidth - prevWidth;
            extending = false;
        });

        // Event delegation: one listener handles taps on any cell.
        sheet.addEventListener('click', (e) => {
            const cell = e.target.closest('.weight-cell');
            if (cell) openWeightEntryModal(cell.dataset.date);
        });
    }

    // Refreshes the value/state of already-rendered cells in place. A full
    // rebuild would reset the scroll position, so data changes go through here.
    function refreshWeightSheet() {
        const sheet = document.getElementById('weight-sheet');
        if (!sheet) return;
        sheet.querySelectorAll('.weight-cell').forEach((cell) => {
            const w = state.weightHistory[cell.dataset.date];
            cell.classList.toggle('filled', typeof w === 'number');
            const valLbl = cell.querySelector('.weight-cell-val');
            if (valLbl) valLbl.textContent = typeof w === 'number' ? w.toFixed(1) : '+';
        });
    }

    function weightSheetScrollToEnd() {
        const sheet = document.getElementById('weight-sheet');
        if (!sheet) return;
        // Defer to the next frame: when the tab was hidden, scrollWidth is 0
        // until layout runs.
        requestAnimationFrame(() => { sheet.scrollLeft = sheet.scrollWidth; });
    }

    // Opens the shared number-entry modal for a given day. Empty value clears
    // the entry; otherwise it must be within the sane weight bounds.
    function openWeightEntryModal(dateStr) {
        const modal = document.getElementById('weight-edit-modal');
        const input = document.getElementById('weight-edit-input');
        const title = document.getElementById('weight-edit-modal-title');
        if (!modal || !input) return;
        const label = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        if (title) title.textContent = dateStr === currentDateString ? 'Log weight · Today' : `Log weight · ${label}`;
        const existing = state.weightHistory[dateStr];
        input.value = typeof existing === 'number' ? existing : '';
        modal._editDateStr = dateStr;
        modal.classList.add('active');
        setTimeout(() => input.focus(), 100);
    }

    // Replaces the browsers' native number-input spinners with typeface-consistent,
    // larger, keyboard-accessible -/+ buttons. Each button steps by the input's
    // `step` attribute (default 1) and never goes below zero. The native arrow-key
    // stepping on the input still works too.
    function setupSteppers() {
        document.querySelectorAll('.stepper').forEach((stepper) => {
            const input = stepper.querySelector('input');
            if (!input) return;
            const step = parseFloat(input.getAttribute('step')) || 1;
            const decimals = (String(step).split('.')[1] || '').length;
            stepper.querySelectorAll('.stepper-btn').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const dir = parseFloat(btn.dataset.dir) || 0;
                    let val = parseFloat(input.value);
                    if (isNaN(val)) val = 0;
                    val = Math.max(0, val + dir * step);
                    // toFixed rounds for display and absorbs float drift (0.1 + 0.1 + 0.1).
                    input.value = decimals > 0 ? val.toFixed(decimals) : String(Math.round(val));
                });
            });
        });
    }

    // ===== Event wiring =====
    function setupEventListeners() {
        // Day navigation
        btnPrevDay.addEventListener('click', () => shiftDay(-1));
        btnNextDay.addEventListener('click', () => { if (!btnNextDay.disabled) shiftDay(1); });

        // Calendar popup: click the date title to jump to any past date.
        if (dateTitlesEl && datePickerEl) {
            datePickerEl.max = currentDateString;
            dateTitlesEl.addEventListener('click', () => {
                datePickerEl.value = viewingDateString;
                // showPicker() is the modern API; fall back to focus()+click() for older browsers.
                try {
                    datePickerEl.showPicker();
                } catch (e) {
                    datePickerEl.focus();
                    datePickerEl.click();
                }
            });
            datePickerEl.addEventListener('change', () => jumpToDate(datePickerEl.value));
        }

        // Quick calorie actions
        btnMinus100.addEventListener('click', () => adjustCalories(-100));
        btnMinus50.addEventListener('click', () => adjustCalories(-50));
        btnPlus50.addEventListener('click', () => adjustCalories(50));
        btnPlus100.addEventListener('click', () => adjustCalories(100));

        // Calorie total modal
        caloriesCurrentEl.addEventListener('click', () => {
            caloriesInput.value = state.history[viewingDateString] || 0;
            caloriesModal.classList.add('active');
            setTimeout(() => caloriesInput.focus(), 100);
        });
        btnCancelCalories.addEventListener('click', () => caloriesModal.classList.remove('active'));
        btnSaveCalories.addEventListener('click', () => {
            const newCals = parseInt(caloriesInput.value, 10);
            if (!isNaN(newCals) && newCals >= 0 && newCals <= MAX_CALORIES) {
                state.history[viewingDateString] = newCals;
                saveState();
                updateUI();
            }
            caloriesModal.classList.remove('active');
        });

        // Goal modal (stepper)
        const goalDisplay = document.getElementById('goal-display');
        const goalModalNote = document.getElementById('goal-modal-note');
        let goalVal = state.goal;
        function updateGoalModal() {
            goalDisplay.textContent = goalVal;
            const diff = goalVal - state.maintenance;
            const dir = diff > 0 ? 'gain' : diff < 0 ? 'lose' : 'maintain';
            if (dir === 'maintain') {
                goalModalNote.textContent = 'Based on your TDEE, you are set to maintain your weight.';
            } else {
                const isMetric = state.unit === 'metric';
                const divisor = isMetric ? 7700 : 3500;
                const unitName = isMetric ? 'kg' : 'pound';
                const unitNamePlural = isMetric ? 'kg' : 'pounds';
                const weightPerWeek = Math.abs(diff * 7 / divisor).toFixed(1);
                const unitString = weightPerWeek === '1.0' ? unitName : unitNamePlural;
                goalModalNote.textContent = `Based on your TDEE, you can expect to ${dir} ${weightPerWeek} ${unitString} per week.`;
            }
        }
        if (metricGoalEl) {
            metricGoalEl.addEventListener('click', () => {
                goalVal = state.goal;
                updateGoalModal();
                goalModal.classList.add('active');
            });
        }
        document.getElementById('btn-goal-minus-50').addEventListener('click', () => {
            goalVal = Math.max(500, goalVal - 50);
            updateGoalModal();
        });
        document.getElementById('btn-goal-plus-50').addEventListener('click', () => {
            goalVal = Math.min(9000, goalVal + 50);
            updateGoalModal();
        });
        btnCancelGoal.addEventListener('click', () => goalModal.classList.remove('active'));
        btnSaveGoal.addEventListener('click', () => {
            state.goal = goalVal;
            saveState();
            updateUI();
            goalModal.classList.remove('active');
        });

        // TDEE modal (stepper)
        const maintDisplay = document.getElementById('maint-display');
        let maintVal = state.maintenance;
        if (metricMaintEl) {
            metricMaintEl.addEventListener('click', () => {
                maintVal = state.maintenance;
                maintDisplay.textContent = maintVal;
                maintModal.classList.add('active');
            });
        }
        document.getElementById('btn-maint-minus-50').addEventListener('click', () => {
            maintVal = Math.max(500, maintVal - 50);
            maintDisplay.textContent = maintVal;
        });
        document.getElementById('btn-maint-plus-50').addEventListener('click', () => {
            maintVal = Math.min(9000, maintVal + 50);
            maintDisplay.textContent = maintVal;
        });
        btnCancelMaint.addEventListener('click', () => maintModal.classList.remove('active'));
        btnSaveMaint.addEventListener('click', () => {
            state.maintenance = maintVal;
            saveState();
            updateUI();
            maintModal.classList.remove('active');
        });

        // Preset modal
        btnAddPreset.addEventListener('click', () => {
            presetNameInput.value = '';
            presetCalInput.value = '';
            presetModal.classList.add('active');
            setTimeout(() => presetNameInput.focus(), 100);
        });
        btnCancelPreset.addEventListener('click', () => presetModal.classList.remove('active'));
        btnSavePreset.addEventListener('click', () => {
            if (presets.length >= MAX_PRESETS) {
                alert(`Maximum of ${MAX_PRESETS} presets allowed.`);
                return;
            }
            const name = presetNameInput.value.trim().slice(0, MAX_PRESET_NAME);
            const cal = parseInt(presetCalInput.value, 10);
            if (name && !isNaN(cal) && cal !== 0 && Math.abs(cal) <= MAX_CALORIES) {
                presets.push({ id: Date.now(), name, calories: cal });
                savePresets();
            }
            presetModal.classList.remove('active');
        });

        // Close modals on overlay click
        [caloriesModal, goalModal, maintModal, presetModal].forEach((modal) => {
            if (modal) {
                modal.addEventListener('click', (e) => {
                    if (e.target === modal) modal.classList.remove('active');
                });
            }
        });

        caloriesCurrentEl.style.transition = 'transform 0.15s ease-out';
        setupSteppers();
        setupTabsSettingsAndWeight();
    }

    function setupTabsSettingsAndWeight() {
        const navTabs = Array.from(document.querySelectorAll('.nav-tab'));
        const tabPanes = document.querySelectorAll('.tab-pane');

        function switchToTab(index) {
            const clamped = Math.max(0, Math.min(navTabs.length - 1, index));
            const oldIdx = navTabs.findIndex((t) => t.classList.contains('active'));
            if (oldIdx === clamped) return;

            navTabs.forEach((t) => t.classList.remove('active'));
            navTabs[clamped].classList.add('active');
            const dir = clamped > oldIdx ? 'right' : 'left';

            tabPanes.forEach((p) => {
                p.classList.remove('active', 'slide-in-right', 'slide-in-left', 'slide-out-right', 'slide-out-left');
            });
            if (oldIdx >= 0) {
                const oldPane = document.getElementById(navTabs[oldIdx].getAttribute('data-target'));
                oldPane.classList.add('active', dir === 'right' ? 'slide-out-left' : 'slide-out-right');
                setTimeout(() => {
                    if (!oldPane.classList.contains('slide-in-right') && !oldPane.classList.contains('slide-in-left')) {
                        oldPane.classList.remove('active', 'slide-out-left', 'slide-out-right');
                    }
                }, 250);
            }
            const newPane = document.getElementById(navTabs[clamped].getAttribute('data-target'));
            newPane.classList.add('active', dir === 'right' ? 'slide-in-right' : 'slide-in-left');

            if (navTabs[clamped].getAttribute('data-target') === 'tab-weight') {
                renderWeightTab();
                refreshWeightSheet();
                weightSheetScrollToEnd();
            }
        }

        navTabs.forEach((tab, i) => tab.addEventListener('click', () => switchToTab(i)));

        // Horizontal swipe to change tabs. Ignored when the swipe starts inside
        // the weight sheet — that is itself a horizontal scroller, so a swipe
        // there should scroll the row, not flip tabs.
        let touchStartX = 0;
        let touchStartY = 0;
        let touchInScroller = false;
        document.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            touchInScroller = !!(e.target.closest && e.target.closest('#weight-sheet'));
        }, { passive: true });
        document.addEventListener('touchend', (e) => {
            if (touchInScroller) return;
            const dx = e.changedTouches[0].clientX - touchStartX;
            const dy = e.changedTouches[0].clientY - touchStartY;
            if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
            const activeIdx = navTabs.findIndex((t) => t.classList.contains('active'));
            switchToTab(activeIdx + (dx < 0 ? 1 : -1));
        }, { passive: true });

        // Settings modal
        document.getElementById('btn-settings').addEventListener('click', () => {
            applyThemeAndUnits();
            document.getElementById('modal-settings').classList.add('active');
        });
        document.getElementById('close-modal-settings').addEventListener('click', () => {
            document.getElementById('modal-settings').classList.remove('active');
        });
        document.querySelectorAll('.modal-overlay').forEach((modal) => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.classList.remove('active');
            });
        });

        // Dark / light mode
        document.querySelectorAll('.theme-mode-toggle').forEach((btn) => {
            btn.addEventListener('click', () => {
                state.theme = btn.getAttribute('data-mode') === 'dark' ? 'dark' : 'light';
                saveState();
                applyThemeAndUnits();
            });
        });

        // Unit system
        document.querySelectorAll('.unit-toggle').forEach((btn) => {
            btn.addEventListener('click', () => {
                state.unit = btn.getAttribute('data-unit') === 'metric' ? 'metric' : 'imperial';
                saveState();
                applyThemeAndUnits();
                updateUI();
                const weightTab = document.getElementById('tab-weight');
                if (weightTab && weightTab.classList.contains('active')) renderWeightTab();
            });
        });

        // Weight tab: chart range toggles + the scrolling entry sheet
        const weightChartToggles = document.querySelectorAll('#weight-chart-toggles .chart-toggle');
        weightChartToggles.forEach((t) => {
            t.addEventListener('click', () => {
                weightChartToggles.forEach((b) => b.classList.remove('active'));
                t.classList.add('active');
                currentWeightRange = t.getAttribute('data-range');
                renderWeightTab();
            });
        });

        setupWeightSheet();
        setupWeightChartInteraction();
    }

    // Chart scrubber + per-point edit/delete popup.
    function setupWeightChartInteraction() {
        const chartOverlay = document.getElementById('weight-chart-overlay');
        const scrubberLine = document.getElementById('weight-scrubber-line');
        const scrubberDot = document.getElementById('weight-scrubber-dot');
        const scrubberLabel = document.getElementById('weight-scrubber-label');
        const dotPopup = document.getElementById('weight-dot-popup');
        const dotEditBtn = document.getElementById('weight-dot-edit-btn');
        const dotDeleteBtn = document.getElementById('weight-dot-delete-btn');
        const weightEditModal = document.getElementById('weight-edit-modal');
        const weightEditInput = document.getElementById('weight-edit-input');
        const btnSaveWeightEdit = document.getElementById('btn-save-weight-edit');
        const btnCancelWeightEdit = document.getElementById('btn-cancel-weight-edit');

        function updateScrubber(clientX) {
            if (!currentSvgPts || currentSvgPts.length === 0) return null;
            // The overlay shares the chart drawing box, so its rect maps 1:1 to
            // the 0-100 coordinate space the points are stored in.
            const rect = chartOverlay.getBoundingClientRect();
            const svgX = ((clientX - rect.left) / rect.width) * 100;
            const nearest = currentSvgPts.reduce((prev, curr) =>
                Math.abs(curr.x - svgX) < Math.abs(prev.x - svgX) ? curr : prev
            );
            scrubberLine.setAttribute('x1', nearest.x.toFixed(2));
            scrubberLine.setAttribute('x2', nearest.x.toFixed(2));
            scrubberLine.style.display = '';
            scrubberDot.style.left = `${nearest.x}%`;
            scrubberDot.style.top = `${nearest.y}%`;
            scrubberDot.style.display = '';
            if (scrubberLabel) {
                const unitName = state.unit === 'metric' ? 'kg' : 'lbs';
                const label = nearest.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                scrubberLabel.textContent = `${label} · ${nearest.weight.toFixed(1)} ${unitName}`;
            }
            return nearest;
        }
        function hideScrubber() {
            if (scrubberLine) scrubberLine.style.display = 'none';
            if (scrubberDot) scrubberDot.style.display = 'none';
            if (scrubberLabel) scrubberLabel.textContent = '';
        }
        function closeDotPopup() {
            if (dotPopup) dotPopup.style.display = 'none';
            activeDotDateStr = null;
        }

        if (chartOverlay) {
            chartOverlay.addEventListener('mousemove', (e) => updateScrubber(e.clientX));
            chartOverlay.addEventListener('mouseleave', hideScrubber);
            chartOverlay.addEventListener('touchstart', (e) => updateScrubber(e.touches[0].clientX), { passive: true });
            chartOverlay.addEventListener('touchmove', (e) => {
                e.preventDefault();
                updateScrubber(e.touches[0].clientX);
            }, { passive: false });
            chartOverlay.addEventListener('touchend', hideScrubber);
            chartOverlay.addEventListener('click', (e) => {
                // Stop the click bubbling to the document-level "close popup" handler,
                // otherwise the popup we are about to open is closed in the same event.
                e.stopPropagation();
                const nearest = updateScrubber(e.clientX);
                if (!nearest) return;
                activeDotDateStr = nearest.dateStr;
                const dotDate = document.getElementById('weight-dot-popup-date');
                const unitName = state.unit === 'metric' ? 'kg' : 'lbs';
                if (dotDate) {
                    const label = nearest.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    dotDate.textContent = `${label} · ${nearest.weight.toFixed(1)} ${unitName}`;
                }
                if (dotPopup) {
                    dotPopup.style.display = 'block';
                    const pw = dotPopup.offsetWidth || 140;
                    const ph = dotPopup.offsetHeight || 90;
                    let left = e.clientX - pw / 2;
                    let top = e.clientY - ph - 10;
                    if (left < 8) left = 8;
                    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
                    if (top < 8) top = e.clientY + 14;
                    dotPopup.style.left = `${left}px`;
                    dotPopup.style.top = `${top}px`;
                }
            });
        }

        if (dotEditBtn) {
            dotEditBtn.addEventListener('click', () => {
                if (!activeDotDateStr) return;
                const dateStr = activeDotDateStr;
                closeDotPopup();
                openWeightEntryModal(dateStr); // shared modal — same one the sheet uses
            });
        }

        let deleteConfirming = false;
        if (dotDeleteBtn) {
            dotDeleteBtn.addEventListener('click', () => {
                if (deleteConfirming || !activeDotDateStr) return;
                deleteConfirming = true;
                const dateStr = activeDotDateStr;
                const label = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                const popupDateEl = document.getElementById('weight-dot-popup-date');
                const originalText = popupDateEl ? popupDateEl.textContent : '';
                if (popupDateEl) popupDateEl.textContent = `Delete ${label}?`;
                dotEditBtn.style.display = 'none';
                dotDeleteBtn.textContent = 'Yes, delete';

                let cancelBtn = document.getElementById('weight-dot-delete-cancel');
                if (!cancelBtn) {
                    cancelBtn = document.createElement('button');
                    cancelBtn.id = 'weight-dot-delete-cancel';
                    cancelBtn.style.cssText = 'display:block; width:100%; text-align:left; background:none; border:none; color:var(--text-secondary); font-family:var(--font-main); font-size:14px; font-weight:var(--font-weight-regular); padding:10px 14px; cursor:pointer;';
                    dotPopup.appendChild(cancelBtn);
                }
                cancelBtn.textContent = 'Cancel';
                cancelBtn.style.display = 'block';

                function reset() {
                    deleteConfirming = false;
                    dotEditBtn.style.display = 'block';
                    dotDeleteBtn.textContent = 'Delete';
                    if (popupDateEl) popupDateEl.textContent = originalText;
                    if (cancelBtn) cancelBtn.style.display = 'none';
                }
                function confirmDelete(e) {
                    e.stopPropagation();
                    cancelBtn.removeEventListener('click', cancelDelete);
                    closeDotPopup();
                    reset();
                    delete state.weightHistory[dateStr];
                    saveState();
                    refreshWeightSheet();
                    renderWeightTab();
                }
                function cancelDelete(e) {
                    e.stopPropagation();
                    dotDeleteBtn.removeEventListener('click', confirmDelete);
                    reset();
                }
                dotDeleteBtn.addEventListener('click', confirmDelete, { once: true });
                cancelBtn.addEventListener('click', cancelDelete, { once: true });
            });
        }

        if (btnSaveWeightEdit) {
            btnSaveWeightEdit.addEventListener('click', () => {
                const dateStr = weightEditModal._editDateStr;
                if (dateStr) {
                    const raw = weightEditInput.value.trim();
                    if (raw === '') {
                        delete state.weightHistory[dateStr]; // empty input clears the entry
                    } else {
                        const val = parseFloat(raw);
                        if (!isNaN(val) && val >= MIN_WEIGHT && val <= MAX_WEIGHT) {
                            state.weightHistory[dateStr] = val;
                        }
                    }
                    saveState();
                    refreshWeightSheet();
                    renderWeightTab();
                }
                weightEditModal.classList.remove('active');
            });
        }
        if (btnCancelWeightEdit) {
            btnCancelWeightEdit.addEventListener('click', () => weightEditModal.classList.remove('active'));
        }
        if (weightEditModal) {
            weightEditModal.addEventListener('click', (e) => {
                if (e.target === weightEditModal) weightEditModal.classList.remove('active');
            });
        }

        // Close the dot popup when clicking anywhere outside it.
        document.addEventListener('click', (e) => {
            if (dotPopup && dotPopup.style.display !== 'none' && !dotPopup.contains(e.target)) {
                dotPopup.style.display = 'none';
            }
        });
    }
});
