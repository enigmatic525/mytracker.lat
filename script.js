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
    const defaultGoal = 2000;       // legacy absolute goal, used only for migration
    const defaultMaintenance = 2500;
    // Goal is now a signed daily energy balance target (intake − expenditure):
    // negative = deficit (lose), 0 = maintain, positive = surplus (gain).
    const defaultGoalBalance = defaultGoal - defaultMaintenance; // −500
    const GOAL_BALANCE_LIMIT = 1500; // clamp for the goal stepper, ± this
    const MIN_WEIGHT = 1;          // sanity bounds for input validation
    const MAX_WEIGHT = 1500;
    // A day's total intake (and, separately, total activity) is capped here. Entries
    // that would push the running total past this are clamped to the remaining room.
    const DAILY_CAL_CAP = 10000;
    // The pending-amount wheel: scroll left/right (in steps of 50) to set the
    // amount, then a meter tap logs it. Item width must match .hwheel-item (and the
    // side-padding/highlight) in the CSS, or the snap won't center cleanly.
    const PENDING_STEP = 50;
    const PENDING_MAX = 5000;       // any single entry beyond this can be logged twice
    const PENDING_ITEM_W = 72;
    // The tallest value in the weekly chart reaches this % of the plot height; the
    // rest is headroom for the diff label sitting above the bar. Kept well under 100
    // because the scroller clips overflow vertically (overflow-y: hidden), so a bar
    // that topped out near 100% would have its label cut off. Declared up here so
    // init()'s first render can't hit a temporal-dead-zone error.
    const CHART_TOP = 80;
    const STORAGE_KEY = 'calorieTrackerStateV2';

    // ===== State =====
    // history maps a date to { in, out }: `in` = calories eaten, `out` = activity
    // burned on top of TDEE. Total expenditure for a day is maintenance + out.
    let state = {
        goalBalance: defaultGoalBalance,
        // `maintenance` is the baseline BMR+NEAT used for days before any dated
        // change. `maintenanceHistory` holds dated breakpoints: editing BMR+NEAT
        // while viewing a day writes a breakpoint there, so the change applies from
        // that day forward without rewriting earlier days. See maintenanceFor().
        maintenance: defaultMaintenance,
        maintenanceHistory: {}, // { 'YYYY-MM-DD': value } — "effective from this date"
        history: {},          // { 'YYYY-MM-DD': [ { id, t:'in'|'out', a } ] }
        weightHistory: {},    // { 'YYYY-MM-DD': weight }
        theme: 'light',       // 'light' | 'dark'
        unit: 'imperial'      // 'imperial' | 'metric'
    };

    let currentDateString = getTodayDateString();
    let viewingDateString = currentDateString;

    // The pending amount the wheel is centered on; tapping a meter logs it there.
    // Declared up here (not beside the wheel helpers) because setupEventListeners —
    // which runs during init() — touches them before that code is reached.
    let pendingAmount = 0;
    let pendingSelectedIdx = -1;   // which wheel row is centered/selected
    let pendingScrollRaf = 0;      // rAF handle that throttles the scroll handler
    // Monotonic counter for entry ids (unique within a session is enough — ids are
    // only used to delete a specific log row).
    let entrySeq = 0;
    function nextEntryId() {
        entrySeq += 1;
        return `${Date.now().toString(36)}-${entrySeq.toString(36)}`;
    }

    // Weight-tab state shared between the renderer and the chart interaction handlers.
    let currentWeightRange = 'month';
    let activeDotDateStr = null;
    let currentSvgPts = [];

    // Bounds of the day range currently built into the weight sheet. The sheet
    // grows past these as you scroll or jump to an out-of-range date.
    let weightSheetOldest = null;
    let weightSheetLatest = null;

    // ===== DOM references =====
    const dateEl = document.getElementById('current-date');
    const dayLabelEl = document.getElementById('day-label');
    const dateTitlesEl = document.getElementById('date-titles');
    const calendarModal = document.getElementById('calendar-modal');
    const calGridEl = document.getElementById('cal-grid');
    const calMonthLabelEl = document.getElementById('cal-month-label');
    const calPrevMonthEl = document.getElementById('cal-prev-month');
    const calNextMonthEl = document.getElementById('cal-next-month');
    const caloriesLeftEl = document.getElementById('calories-left');
    const metricGoalEl = document.getElementById('metric-goal');
    const metricMaintEl = document.getElementById('metric-maint');
    const metricGoalValEl = document.getElementById('metric-goal-val');
    const metricMaintValEl = document.getElementById('metric-maint-val');

    const btnPrevDay = document.getElementById('btn-prev-day');
    const btnNextDay = document.getElementById('btn-next-day');

    const progressBarFill = document.getElementById('progress-bar-fill');

    // In/out meters + slider adder
    const meterInEl = document.getElementById('meter-in');
    const meterOutEl = document.getElementById('meter-out');
    const meterInValEl = document.getElementById('meter-in-val');
    const meterOutValEl = document.getElementById('meter-out-val');
    const meterInHintEl = document.getElementById('meter-in-hint');
    const meterOutHintEl = document.getElementById('meter-out-hint');
    const pendingWheelScrollEl = document.getElementById('pending-wheel-scroll');
    const logListInEl = document.getElementById('log-list-in');
    const logListOutEl = document.getElementById('log-list-out');
    const logEmptyInEl = document.getElementById('log-empty-in');
    const logEmptyOutEl = document.getElementById('log-empty-out');

    const chartBarsEl = document.getElementById('chart-bars');
    const weeklyDiffLabelEl = document.getElementById('weekly-difference-label');

    const goalModal = document.getElementById('goal-modal');
    const btnCancelGoal = document.getElementById('btn-cancel-goal');
    const btnSaveGoal = document.getElementById('btn-save-goal');

    const maintModal = document.getElementById('maint-modal');
    const btnCancelMaint = document.getElementById('btn-cancel-maint');
    const btnSaveMaint = document.getElementById('btn-save-maint');

    // ===== Init =====
    init();

    function init() {
        loadState();
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
                const maintenance = typeof p.maintenance === 'number' ? p.maintenance : defaultMaintenance;
                // Prefer the new signed-balance field; migrate a legacy absolute
                // `goal` by expressing it relative to maintenance.
                let goalBalance = defaultGoalBalance;
                if (typeof p.goalBalance === 'number' && isFinite(p.goalBalance)) {
                    goalBalance = p.goalBalance;
                } else if (typeof p.goal === 'number' && isFinite(p.goal)) {
                    goalBalance = p.goal - maintenance;
                }
                state = {
                    goalBalance: Math.max(-GOAL_BALANCE_LIMIT, Math.min(GOAL_BALANCE_LIMIT, goalBalance)),
                    maintenance: maintenance,
                    maintenanceHistory: sanitizeMaintenanceMap(p.maintenanceHistory),
                    history: sanitizeHistoryMap(p.history),
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
                    if (typeof old.goal === 'number') state.goalBalance = old.goal - state.maintenance;
                    if (old.lastUpdated && typeof old.calories === 'number' && old.calories > 0) {
                        state.history[old.lastUpdated] = [{ id: nextEntryId(), t: 'in', a: old.calories }];
                    }
                } catch (e) {}
            }
        }
        applyThemeAndUnits();
    }

    // Keep only 'YYYY-MM-DD' -> in-range maintenance breakpoints, clamped to the
    // same bounds the stepper enforces so a hand-edited blob can't inject a wild value.
    function sanitizeMaintenanceMap(obj) {
        const out = {};
        if (obj && typeof obj === 'object') {
            Object.keys(obj).forEach((k) => {
                if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof obj[k] === 'number' && isFinite(obj[k])) {
                    out[k] = Math.max(500, Math.min(9000, Math.round(obj[k])));
                }
            });
        }
        return out;
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

    // Each day is now a list of entries: [{ id, t:'in'|'out', a }]. Migrate the two
    // older formats (a bare number = one `in` entry; an { in, out } object = up to
    // two entries) so existing data survives. Fresh ids are assigned on load.
    function sanitizeHistoryMap(obj) {
        const out = {};
        const pos = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);
        if (obj && typeof obj === 'object') {
            Object.keys(obj).forEach((k) => {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return;
                const v = obj[k];
                const entries = [];
                if (typeof v === 'number') {
                    if (pos(v)) entries.push({ id: nextEntryId(), t: 'in', a: pos(v) });
                } else if (Array.isArray(v)) {
                    v.forEach((e) => {
                        if (e && (e.t === 'in' || e.t === 'out') && pos(e.a)) {
                            entries.push({ id: nextEntryId(), t: e.t, a: pos(e.a) });
                        }
                    });
                } else if (v && typeof v === 'object') {
                    if (pos(v.in)) entries.push({ id: nextEntryId(), t: 'in', a: pos(v.in) });
                    if (pos(v.out)) entries.push({ id: nextEntryId(), t: 'out', a: pos(v.out) });
                }
                if (entries.length) out[k] = entries;
            });
        }
        return out;
    }

    // A day's entry list (empty array if none), and its summed in/out totals.
    function getEntries(dateStr) {
        const v = state.history[dateStr];
        return Array.isArray(v) ? v : [];
    }
    function dayData(dateStr) {
        let inSum = 0;
        let outSum = 0;
        getEntries(dateStr).forEach((e) => {
            if (e.t === 'out') outSum += e.a; else inSum += e.a;
        });
        return { in: inSum, out: outSum };
    }

    // The BMR+NEAT in effect on `dateStr`: the latest dated breakpoint on or before
    // that day, or the baseline if the day predates every breakpoint. Keys are
    // 'YYYY-MM-DD', which sort lexicographically, so a string compare gives the
    // right chronological order without parsing dates.
    function maintenanceFor(dateStr) {
        let bestKey = '';
        Object.keys(state.maintenanceHistory).forEach((k) => {
            if (k <= dateStr && k > bestKey) bestKey = k;
        });
        return bestKey ? state.maintenanceHistory[bestKey] : state.maintenance;
    }

    function saveState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {}
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
        const day = dayData(viewingDateString);
        const maint = maintenanceFor(viewingDateString);  // effective BMR+NEAT for this day
        const expenditure = maint + day.out; // TDEE baseline + logged activity
        // Goal is a signed balance target; the intake that hits it = expenditure +
        // goalBalance. (Burning more lets you eat more for the same balance.)
        const targetIn = expenditure + state.goalBalance;

        if (metricGoalValEl) metricGoalValEl.textContent = signed(state.goalBalance);
        if (metricMaintValEl) metricMaintValEl.textContent = maint;
        if (meterInValEl) meterInValEl.textContent = day.in;
        if (meterOutValEl) meterOutValEl.textContent = expenditure;

        const remaining = targetIn - day.in;
        if (caloriesLeftEl) {
            caloriesLeftEl.textContent = remaining >= 0 ? `${remaining} remaining` : `${Math.abs(remaining)} over`;
        }

        // Progress bar tracks intake against the target intake, clamped to [0, 100].
        let percentage = targetIn > 0 ? (day.in / targetIn) * 100 : (day.in > 0 ? 100 : 0);
        percentage = Math.max(0, Math.min(100, percentage));
        if (progressBarFill) {
            progressBarFill.style.width = `${percentage}%`;
            progressBarFill.style.background = day.in > targetIn ? 'var(--danger)' : 'var(--accent-primary)';
        }

        updateMeterHints();
        renderLog();
        renderChart();
    }

    // Formats a signed integer: 0 -> "0", 300 -> "+300", -500 -> "−500".
    function signed(n) {
        if (n > 0) return `+${n}`;
        if (n < 0) return `−${Math.abs(n)}`; // proper minus sign
        return '0';
    }

    // Shows a faint "+N" on each meter box reflecting what a tap would log, so the
    // slider amount and its destinations stay visually connected.
    function updateMeterHints() {
        const hint = pendingAmount > 0 ? `+${pendingAmount}` : '';
        if (meterInHintEl) meterInHintEl.textContent = hint;
        if (meterOutHintEl) meterOutHintEl.textContent = hint;
    }

    // Diverging diff chart: each day's bar is the gap between consumption and that
    // day's TDEE (BMR+NEAT + activity), drawn from a centre line. Above the line
    // (surplus) is green, below (deficit) is red. Bars are only drawn on days food
    // was logged. The centre is "you matched your burn"; the dashed line is the goal.
    function renderChart() {
        chartBarsEl.innerHTML = '';

        // The chart now scrolls, so render from the earliest logged day up to the
        // viewing day rather than a fixed week. Clamp to [7, 90]: always at least
        // a week of columns, never an unbounded scroll on years of data.
        const WEEK = 7;
        const MAX_DAYS = 90;
        const viewDForSpan = new Date(viewingDateString + 'T12:00:00');
        let earliest = viewDForSpan;
        Object.keys(state.history).forEach((k) => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return;
            const d = new Date(k + 'T12:00:00');
            if (d < earliest) earliest = d;
        });
        const span = Math.round((viewDForSpan - earliest) / 86400000) + 1;
        const daysToShow = Math.max(WEEK, Math.min(MAX_DAYS, span));
        const historyData = [];
        let weeklyDiff = 0;
        const viewD = new Date(viewingDateString + 'T12:00:00');
        // Absolute calorie scale shared across the week, so the cals-out (TDEE) and
        // goal lines can sit at each day's real level and rise/fall with that day's
        // burn. Floor at 1 to avoid divide-by-zero on an empty week.
        let maxVal = 1;

        for (let i = daysToShow - 1; i >= 0; i--) {
            const tempD = new Date(viewD.getTime() - i * 86400000);
            const dStr = getDateString(tempD);
            const day = dayData(dStr);
            const tdee = maintenanceFor(dStr) + day.out;  // cals out (BMR+NEAT + burn)
            const goalTarget = tdee + state.goalBalance;  // intake that lands on goal
            const intake = day.in;                        // cals in
            const hasFood = intake > 0;
            const balance = intake - tdee;                // + surplus (green) / − deficit (red)
            // "This week" stays a 7-day figure even though more columns now render.
            if (hasFood && dStr < currentDateString && i < WEEK) weeklyDiff += balance;
            // Every line/bar we draw must fit under the scale.
            maxVal = Math.max(maxVal, tdee, goalTarget, hasFood ? intake : 0);
            historyData.push({
                dateStr: dStr,
                tdee: tdee,
                goalTarget: goalTarget,
                intake: intake,
                balance: balance,
                hasFood: hasFood,
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

        // Map a calorie value to a height %; the largest value tops out at CHART_TOP,
        // leaving headroom for the diff label above the tallest bar.
        const pct = (v) => Math.max(0, Math.min(CHART_TOP, (v / maxVal) * CHART_TOP));

        historyData.forEach((item) => {
            const isViewingDay = item.dateStr === viewingDateString;

            const col = document.createElement('div');
            col.className = `chart-col ${isViewingDay ? 'active' : ''}`;

            const barWrapper = document.createElement('div');
            barWrapper.className = 'chart-bar-wrapper';

            const outH = pct(item.tdee);
            const goalH = pct(item.goalTarget);

            // Per-day cals-out line (solid) and goal line (dashed) — both ride with
            // the day's burn, since goalTarget = tdee + goalBalance.
            const outTick = document.createElement('div');
            outTick.className = `chart-out-tick${isViewingDay ? ' active' : ''}`;
            outTick.style.bottom = `${outH}%`;
            barWrapper.appendChild(outTick);

            const goalTick = document.createElement('div');
            goalTick.className = 'chart-goal-tick';
            goalTick.style.bottom = `${goalH}%`;
            barWrapper.appendChild(goalTick);

            if (item.hasFood) {
                const intakeH = pct(item.intake);
                const surplus = item.balance >= 0;
                // The bar spans the gap between the cals-out line and actual intake:
                // its length is the day's surplus/deficit magnitude.
                const lo = Math.min(intakeH, outH);
                const hi = Math.max(intakeH, outH);

                const bar = document.createElement('div');
                bar.className = `chart-diff-bar ${surplus ? 'surplus' : 'deficit'}${isViewingDay ? ' active' : ''}`;
                bar.style.bottom = `${lo}%`;
                bar.style.height = `${Math.max(hi - lo, 1)}%`;
                barWrapper.appendChild(bar);

                const diffEl = document.createElement('div');
                diffEl.className = 'bar-diff-text';
                const sign = item.balance > 0 ? '+' : '';
                diffEl.textContent = item.balance === 0 ? '0' : `${sign}${item.balance}`;
                // Sit the label just past the top of the bar.
                diffEl.style.bottom = `calc(${hi}% + 2px)`;
                diffEl.style.top = 'auto';
                barWrapper.appendChild(diffEl);
            }

            col.appendChild(barWrapper);

            const labelEl = document.createElement('div');
            labelEl.className = 'chart-label';
            if (isViewingDay) {
                labelEl.style.color = 'var(--text-primary)';
                labelEl.style.fontWeight = '500';
            }
            labelEl.textContent = item.label;
            col.appendChild(labelEl);

            chartBarsEl.appendChild(col);
        });

        // Land on the most recent day. Assigning past the max scrollLeft clamps,
        // so this reliably pins the scroller to its right edge.
        chartBarsEl.scrollLeft = chartBarsEl.scrollWidth;
    }

    // Appends an entry of the given type ('in' or 'out') to the viewing day's log.
    function addEntry(type, amount) {
        if (amount <= 0) return;
        const t = type === 'out' ? 'out' : 'in';
        // Clamp to the room left under the day's per-type cap. If the day is already
        // at the cap, drop the entry and just reset the slider — nothing to log.
        const current = t === 'out' ? dayData(viewingDateString).out : dayData(viewingDateString).in;
        const room = DAILY_CAL_CAP - current;
        if (room <= 0) {
            setPendingAmount(0);
            return;
        }
        const entries = getEntries(viewingDateString).slice();
        entries.push({ id: nextEntryId(), t: t, a: Math.min(room, amount) });
        state.history[viewingDateString] = entries;

        // Pulse the meter that just changed for tactile feedback.
        const valEl = t === 'out' ? meterOutValEl : meterInValEl;
        if (valEl) {
            valEl.style.transform = 'scale(1.15)';
            setTimeout(() => { valEl.style.transform = 'scale(1)'; }, 150);
        }

        saveState();
        setPendingAmount(0); // reset the slider so the same tap can't double-log
        updateUI();
    }

    // Removes one logged entry by id from the viewing day.
    function deleteEntry(id) {
        const entries = getEntries(viewingDateString).filter((e) => e.id !== id);
        if (entries.length) state.history[viewingDateString] = entries;
        else delete state.history[viewingDateString];
        saveState();
        updateUI();
    }

    // Directly sets a meter's total by collapsing that type's entries into a single
    // one. `in` sets intake; `out` sets total expenditure (TDEE + activity), from
    // which we back out the logged activity.
    // ===== Running log =====
    // Splits the viewing day's entries into the green (In) and red (Out) boxes,
    // newest first, each removable via its corner ×.
    function renderLog() {
        if (!logListInEl || !logListOutEl) return;
        const entries = getEntries(viewingDateString);
        renderLogColumn(logListInEl, logEmptyInEl, entries.filter((e) => e.t !== 'out'), 'in');
        renderLogColumn(logListOutEl, logEmptyOutEl, entries.filter((e) => e.t === 'out'), 'out');
    }

    function renderLogColumn(listEl, emptyEl, entries, type) {
        listEl.innerHTML = '';
        if (emptyEl) emptyEl.style.display = entries.length ? 'none' : 'block';
        // Newest at the top without mutating the stored order.
        entries.slice().reverse().forEach((e) => {
            const item = document.createElement('div');
            item.className = `log-item log-${type}`;

            const amt = document.createElement('span');
            amt.className = 'log-amount';
            amt.textContent = `${type === 'out' ? '−' : '+'}${e.a}`;

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'log-delete';
            del.setAttribute('aria-label', `Remove ${type === 'out' ? 'calories out' : 'calories in'} ${e.a}`);
            del.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
            del.addEventListener('click', () => deleteEntry(e.id));

            item.appendChild(amt);
            item.appendChild(del);
            listEl.appendChild(item);
        });
    }

    // ===== Pending-amount wheel + meters =====
    // pendingAmount is the single source of truth: it equals the value the wheel is
    // centered on. A meter tap logs it; logging resets the wheel back to 0.
    // (pendingSelectedIdx / pendingScrollRaf are declared with the top-level state.)

    // Builds the wheel items once (0 … PENDING_MAX, stepping by PENDING_STEP).
    function buildPendingWheel() {
        if (!pendingWheelScrollEl) return;
        const frag = document.createDocumentFragment();
        for (let v = 0; v <= PENDING_MAX; v += PENDING_STEP) {
            const idx = v / PENDING_STEP;
            const item = document.createElement('div');
            item.className = 'hwheel-item';
            item.textContent = v;
            item.addEventListener('click', () => {
                pendingWheelScrollEl.scrollTo({ left: idx * PENDING_ITEM_W, behavior: 'smooth' });
            });
            frag.appendChild(item);
        }
        pendingWheelScrollEl.appendChild(frag);
    }

    // Visually marks the centered item. Kept separate so both the scroll handler and
    // programmatic jumps can reuse it without re-scrolling.
    function markPendingSelected(idx) {
        if (!pendingWheelScrollEl) return;
        const items = pendingWheelScrollEl.children;
        if (pendingSelectedIdx >= 0 && items[pendingSelectedIdx]) items[pendingSelectedIdx].classList.remove('selected');
        if (items[idx]) items[idx].classList.add('selected');
        pendingSelectedIdx = idx;
    }

    // Programmatic set: snaps the amount to the nearest step, scrolls the wheel to
    // it, and updates the meter hints. The resulting scroll event re-runs the
    // handler with the same value (idempotent), so there's no feedback loop.
    function setPendingAmount(value) {
        let v = Math.round(value / PENDING_STEP) * PENDING_STEP;
        v = Math.max(0, Math.min(PENDING_MAX, v));
        pendingAmount = v;
        const idx = v / PENDING_STEP;
        markPendingSelected(idx);
        if (pendingWheelScrollEl) pendingWheelScrollEl.scrollLeft = idx * PENDING_ITEM_W;
        updateMeterHints();
    }

    // ===== Navigation between days / dates =====
    function shiftDay(delta) {
        const d = new Date(viewingDateString + 'T12:00:00');
        d.setDate(d.getDate() + delta);
        const next = getDateString(d);
        if (next > currentDateString) return; // never navigate into the future
        viewingDateString = next;
        updateDateElements();
        refreshActiveView();
    }

    function jumpToDate(dateStr) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
        if (dateStr > currentDateString) dateStr = currentDateString;
        viewingDateString = dateStr;
        updateDateElements();
        refreshActiveView();
    }

    // ===== Custom calendar popup =====
    // The month currently shown in the calendar (always the 1st of that month).
    let calViewDate = null;

    function openCalendar() {
        if (!calendarModal) return;
        calViewDate = new Date(viewingDateString + 'T12:00:00');
        calViewDate.setDate(1);
        renderCalendar();
        calendarModal.classList.add('active');
    }

    function closeCalendar() {
        if (calendarModal) calendarModal.classList.remove('active');
    }

    function renderCalendar() {
        if (!calGridEl || !calViewDate) return;
        const year = calViewDate.getFullYear();
        const month = calViewDate.getMonth();
        calMonthLabelEl.textContent = calViewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

        // getDay() on the 1st = how many blank slots precede it (0 = Sunday).
        const leadingBlanks = new Date(year, month, 1).getDay();
        // Day 0 of next month = last day of this month → its date is the day count.
        const daysInMonth = new Date(year, month + 1, 0).getDate();

        calGridEl.innerHTML = '';
        for (let i = 0; i < leadingBlanks; i++) {
            const blank = document.createElement('div');
            blank.className = 'cal-cell cal-blank';
            calGridEl.appendChild(blank);
        }
        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = getDateString(new Date(year, month, d));
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'cal-cell cal-day';
            cell.textContent = d;
            if (dateStr > currentDateString) {
                cell.disabled = true; // no logging the future
            } else {
                cell.addEventListener('click', () => { jumpToDate(dateStr); closeCalendar(); });
            }
            if (dateStr === currentDateString) cell.classList.add('cal-today');
            if (dateStr === viewingDateString) cell.classList.add('cal-selected');
            calGridEl.appendChild(cell);
        }

        // Block paging past the current month, since future days aren't selectable.
        if (calNextMonthEl) {
            const today = new Date(currentDateString + 'T12:00:00');
            calNextMonthEl.disabled = year === today.getFullYear() && month === today.getMonth();
        }
    }

    function shiftCalendarMonth(delta) {
        if (!calViewDate) return;
        if (delta > 0 && calNextMonthEl && calNextMonthEl.disabled) return;
        calViewDate.setMonth(calViewDate.getMonth() + delta);
        renderCalendar();
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
            weightSheetScrollToDate(viewingDateString);
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

    // Calibrate maintenance (BMR+NEAT) from the past 30 days. Energy balance says
    //   Δweight_kcal = Σ(intake − maintenance − activity)
    // Solving for a constant maintenance over N logged days:
    //   maintenance = avgIntake − avgActivity − (weightSlopePerDay × calPerUnit)
    // The slope comes from the noise-robust regression; the averages come from days
    // you actually logged food. Assumption: logged days are representative of all
    // days (unlogged days bias the average), so we gate on enough data first.
    function computeMaintenanceEstimate() {
        const trend = computeWeightTrend();
        if (!trend) return null; // needs ≥3 weight points to have a real slope
        const cutoff = new Date(currentDateString + 'T12:00:00').getTime() - 30 * 86400000;
        let sumIn = 0;
        let sumOut = 0;
        let nDays = 0;
        Object.keys(state.history).forEach((dStr) => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dStr)) return;
            const t = new Date(dStr + 'T12:00:00').getTime();
            if (t < cutoff || dStr > currentDateString) return;
            const day = dayData(dStr);
            if (day.in <= 0) return; // only days with food logged inform avg intake
            sumIn += day.in;
            sumOut += day.out;
            nDays += 1;
        });
        if (nDays < 10) return null; // too few logged days to trust the estimate
        const cpu = state.unit === 'metric' ? 7700 : 3500; // cal per kg / per lb
        const slopeKcal = trend.slopePerDay * cpu;          // daily balance, in cal
        let est = (sumIn - sumOut) / nDays - slopeKcal;
        est = Math.max(800, Math.min(9000, Math.round(est / 10) * 10)); // sane, rounded
        // Compare against today's effective baseline (maintenance can now vary by day).
        const current = maintenanceFor(currentDateString);
        return { est, current, delta: est - current, nDays };
    }

    // The "should-be" weight curve: start from your first logged weight in the
    // visible window, then walk forward day by day adding each day's energy balance
    // (intake − maintenance − activity) converted to weight units. This is where
    // your weight *should* sit given what you ate and your assumed maintenance;
    // divergence from the real line is exactly the maintenance error.
    function computeShouldBeCurve(allSlots) {
        const cpu = state.unit === 'metric' ? 7700 : 3500;
        const anchor = allSlots.find((s) => s.weight !== null);
        if (!anchor) return [];
        const out = [];
        let predicted = anchor.weight;
        for (const slot of allSlots) {
            if (slot.future) break;                       // intake unknown past today
            if (slot.slotIndex < anchor.slotIndex) continue;
            if (slot.slotIndex !== anchor.slotIndex) {
                const day = dayData(slot.dateStr);
                // Unlogged days move nothing — we have no intake to score them.
                const balanceKcal = day.in > 0 ? day.in - maintenanceFor(slot.dateStr) - day.out : 0;
                predicted += balanceKcal / cpu;
            }
            out.push({ slotIndex: slot.slotIndex, weight: predicted });
        }
        return out;
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
        const shouldBeLineEl = document.getElementById('weight-shouldbe-line');
        const summaryEl = document.getElementById('weight-projection-summary');
        const maintSummaryEl = document.getElementById('weight-maint-summary');
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

        // Maintenance calibration: tell the user whether their BMR+NEAT looks off,
        // and explain the gray dashed line they're now seeing.
        if (maintSummaryEl) {
            const m = computeMaintenanceEstimate();
            if (m) {
                const absDelta = Math.abs(m.delta);
                if (absDelta < 75) {
                    maintSummaryEl.textContent = `Dashed = weight predicted from intake. Your last ${m.nDays} logged days imply maintenance ≈ ${m.est} cal — close to your ${m.current}. ✓`;
                } else {
                    const dir = m.delta > 0 ? 'higher' : 'lower';
                    maintSummaryEl.textContent = `Dashed = weight predicted from intake. Your last ${m.nDays} logged days imply maintenance ≈ ${m.est} cal — ${absDelta} ${dir} than your ${m.current}.`;
                }
                maintSummaryEl.style.display = '';
            } else {
                maintSummaryEl.style.display = 'none';
            }
        }

        // Reset chart elements. dotsEl also contains the persistent scrubber dot,
        // so clear only the data dots, not the whole container.
        if (xAxisEl) xAxisEl.innerHTML = '';
        if (yAxisEl) yAxisEl.innerHTML = '';
        if (dotsEl) dotsEl.querySelectorAll('.weight-dot').forEach((d) => d.remove());
        if (maLineEl) maLineEl.setAttribute('d', '');
        if (projLineEl) projLineEl.style.display = 'none';
        if (shouldBeLineEl) { shouldBeLineEl.setAttribute('d', ''); shouldBeLineEl.style.display = 'none'; }

        if (dataPoints.length < 2) {
            pathLine.setAttribute('d', '');
            if (emptyEl) emptyEl.style.display = 'flex';
            currentSvgPts = [];
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        // "Should-be" weight from intake. Skip on the year view (a 365-day cumulative
        // can drift far enough to swamp the axis) to match the projection's behavior.
        const shouldBe = currentWeightRange !== 'year' ? computeShouldBeCurve(allSlots) : [];

        // Y range with padding — fold in the projected endpoint and the should-be
        // curve so neither runs off-canvas.
        let maxW = Math.max(...dataPoints.map((p) => p.weight));
        let minW = Math.min(...dataPoints.map((p) => p.weight));
        if (allowProjection && extraDays > 0) {
            const lastReal = dataPoints[dataPoints.length - 1];
            const projEnd = lastReal.weight + trend.slopePerDay * ((days - 1 + extraDays) - lastReal.slotIndex);
            maxW = Math.max(maxW, projEnd);
            minW = Math.min(minW, projEnd);
        }
        if (shouldBe.length) {
            maxW = Math.max(maxW, ...shouldBe.map((s) => s.weight));
            minW = Math.min(minW, ...shouldBe.map((s) => s.weight));
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

        // Should-be line — predicted weight from intake, same coordinate mapping.
        if (shouldBeLineEl) {
            if (shouldBe.length >= 2) {
                const sbPts = shouldBe.map((s) => ({
                    x: (s.slotIndex / xRange) * 100,
                    y: 100 - ((s.weight - minW) / yRange) * 100
                }));
                shouldBeLineEl.setAttribute('d', straightPath(sbPts));
                shouldBeLineEl.style.display = '';
            } else {
                shouldBeLineEl.setAttribute('d', '');
                shouldBeLineEl.style.display = 'none';
            }
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
        if (dateStr === viewingDateString) cell.classList.add('viewing');
        // Future days are shown but greyed out — you can't log a weight that hasn't happened.
        if (dateStr > currentDateString) cell.classList.add('future');
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

    // Builds the initial cells, wires "extend on scroll" in both directions, and
    // delegates cell clicks to the entry modal. Runs once at startup. The row
    // spans past *and* future days; future cells are greyed out and inert.
    function setupWeightSheet() {
        const sheet = document.getElementById('weight-sheet');
        if (!sheet) return;
        const today = new Date(currentDateString + 'T12:00:00');
        weightSheetOldest = new Date(today.getTime() - 44 * 86400000); // ~6 weeks of history
        weightSheetLatest = new Date(today.getTime() + 14 * 86400000); // 2 weeks ahead

        for (let t = weightSheetOldest.getTime(); t <= weightSheetLatest.getTime(); t += 86400000) {
            sheet.appendChild(buildWeightCell(getDateString(new Date(t))));
        }

        // The row "keeps extending" at both ends. Near the left edge, prepend
        // older days and bump scrollLeft by the width added so the viewport
        // stays put; near the right edge, append future days.
        let extending = false;
        sheet.addEventListener('scroll', () => {
            if (extending) return;
            if (sheet.scrollLeft <= 80) {
                extending = true;
                const prevWidth = sheet.scrollWidth;
                const frag = document.createDocumentFragment();
                for (let i = 30; i >= 1; i--) {
                    frag.appendChild(buildWeightCell(getDateString(new Date(weightSheetOldest.getTime() - i * 86400000))));
                }
                weightSheetOldest = new Date(weightSheetOldest.getTime() - 30 * 86400000);
                sheet.insertBefore(frag, sheet.firstChild);
                sheet.scrollLeft += sheet.scrollWidth - prevWidth;
                extending = false;
            } else if (sheet.scrollWidth - sheet.scrollLeft - sheet.clientWidth <= 80) {
                extending = true;
                const frag = document.createDocumentFragment();
                for (let i = 1; i <= 30; i++) {
                    frag.appendChild(buildWeightCell(getDateString(new Date(weightSheetLatest.getTime() + i * 86400000))));
                }
                weightSheetLatest = new Date(weightSheetLatest.getTime() + 30 * 86400000);
                sheet.appendChild(frag);
                extending = false;
            }
        });

        // Event delegation: one listener handles taps on any cell. Future cells
        // also carry `pointer-events: none`, so this guard is just defence.
        sheet.addEventListener('click', (e) => {
            const cell = e.target.closest('.weight-cell');
            if (cell && !cell.classList.contains('future')) openWeightEntryModal(cell.dataset.date);
        });
    }

    // Grows the sheet outward so `dateStr` (plus a week of padding) is built,
    // letting jump-to-date land on a cell even when it's far outside the range.
    function ensureWeightSheetCovers(dateStr) {
        const sheet = document.getElementById('weight-sheet');
        if (!sheet || !weightSheetOldest || !weightSheetLatest) return;
        const target = new Date(dateStr + 'T12:00:00');
        const pad = 7 * 86400000;
        if (target.getTime() < weightSheetOldest.getTime()) {
            const newOldest = new Date(target.getTime() - pad);
            const frag = document.createDocumentFragment();
            for (let t = newOldest.getTime(); t < weightSheetOldest.getTime(); t += 86400000) {
                frag.appendChild(buildWeightCell(getDateString(new Date(t))));
            }
            sheet.insertBefore(frag, sheet.firstChild);
            weightSheetOldest = newOldest;
        }
        if (target.getTime() > weightSheetLatest.getTime()) {
            const newLatest = new Date(target.getTime() + pad);
            const frag = document.createDocumentFragment();
            for (let t = weightSheetLatest.getTime() + 86400000; t <= newLatest.getTime(); t += 86400000) {
                frag.appendChild(buildWeightCell(getDateString(new Date(t))));
            }
            sheet.appendChild(frag);
            weightSheetLatest = newLatest;
        }
    }

    // Refreshes the value/state of already-rendered cells in place, including
    // which cell is the active "viewing" day. A full rebuild would reset the
    // scroll position, so data changes go through here.
    function refreshWeightSheet() {
        const sheet = document.getElementById('weight-sheet');
        if (!sheet) return;
        sheet.querySelectorAll('.weight-cell').forEach((cell) => {
            const w = state.weightHistory[cell.dataset.date];
            cell.classList.toggle('filled', typeof w === 'number');
            cell.classList.toggle('viewing', cell.dataset.date === viewingDateString);
            const valLbl = cell.querySelector('.weight-cell-val');
            if (valLbl) valLbl.textContent = typeof w === 'number' ? w.toFixed(1) : '+';
        });
    }

    // Scrolls the sheet so the cell for `dateStr` sits centered in the viewport.
    function weightSheetScrollToDate(dateStr) {
        const sheet = document.getElementById('weight-sheet');
        if (!sheet) return;
        ensureWeightSheetCovers(dateStr);
        // Defer to the next frame: when the tab was hidden, layout (and thus
        // every cell's geometry) isn't resolved until it paints.
        requestAnimationFrame(() => {
            const cell = sheet.querySelector(`.weight-cell[data-date="${dateStr}"]`);
            if (!cell) return;
            const cellRect = cell.getBoundingClientRect();
            const sheetRect = sheet.getBoundingClientRect();
            const delta = (cellRect.left + cellRect.width / 2) - (sheetRect.left + sheetRect.width / 2);
            sheet.scrollLeft += delta;
        });
    }

    // ===== Weight wheel picker (the vertical scroll in the entry modal) =====
    const PICKER_ROW_H = 40;        // must match .weight-picker-row height in CSS
    const PICKER_STEP = 0.1;        // one row per 0.1 weight unit
    let pickerValues = [];          // the value sitting at each row, in order
    let pickerSelectedIdx = -1;     // index of the centered (selected) row
    let pickerScrollRaf = 0;        // rAF handle to throttle the scroll handler

    // The most recent logged weight strictly before `dateStr`, or null. Seeds the
    // wheel so it opens on "yesterday's" number and you nudge up/down from there.
    function nearestPriorWeight(dateStr) {
        const priorKeys = Object.keys(state.weightHistory).filter((k) => k < dateStr).sort();
        if (!priorKeys.length) return null;
        return state.weightHistory[priorKeys[priorKeys.length - 1]];
    }

    // Builds the row column spanning center ± span (clamped to sane bounds) and
    // returns the index whose value equals `center`, so the caller can scroll to it.
    function buildWeightPicker(center) {
        const scrollEl = document.getElementById('weight-picker-scroll');
        if (!scrollEl) return 0;
        const span = state.unit === 'metric' ? 25 : 50; // ± window around the seed
        const lo = Math.max(MIN_WEIGHT, Math.round((center - span) * 10) / 10);
        const hi = Math.min(MAX_WEIGHT, Math.round((center + span) * 10) / 10);
        // Integer row count + index-based values, so float drift can't accumulate
        // across hundreds of 0.1 additions.
        const count = Math.round((hi - lo) / PICKER_STEP) + 1;

        pickerValues = [];
        const frag = document.createDocumentFragment();
        let centerIdx = 0;
        for (let i = 0; i < count; i++) {
            const val = Math.round((lo + i * PICKER_STEP) * 10) / 10;
            pickerValues.push(val);
            if (Math.abs(val - center) < PICKER_STEP / 2) centerIdx = i;
            const row = document.createElement('div');
            row.className = 'wheel-row';
            row.textContent = val.toFixed(1);
            // Tapping a row snaps it to the center selection.
            row.addEventListener('click', () => {
                scrollEl.scrollTo({ top: i * PICKER_ROW_H, behavior: 'smooth' });
            });
            frag.appendChild(row);
        }
        scrollEl.innerHTML = '';
        scrollEl.appendChild(frag);
        pickerSelectedIdx = -1;
        return centerIdx;
    }

    // Marks whichever row is centered under the highlight band as selected, and
    // records its value. Snap maps scrollTop to an exact row, so rounding is safe.
    function updateWeightPickerSelection() {
        const scrollEl = document.getElementById('weight-picker-scroll');
        if (!scrollEl || !pickerValues.length) return;
        let idx = Math.round(scrollEl.scrollTop / PICKER_ROW_H);
        idx = Math.max(0, Math.min(pickerValues.length - 1, idx));
        if (idx === pickerSelectedIdx) return;
        const rows = scrollEl.children;
        if (pickerSelectedIdx >= 0 && rows[pickerSelectedIdx]) rows[pickerSelectedIdx].classList.remove('selected');
        if (rows[idx]) rows[idx].classList.add('selected');
        pickerSelectedIdx = idx;
    }

    // Opens the weight-entry modal for a given day. The wheel seeds on the day's
    // existing value, else the previous day's weight, else a unit-sane default.
    function openWeightEntryModal(dateStr) {
        const modal = document.getElementById('weight-edit-modal');
        const scrollEl = document.getElementById('weight-picker-scroll');
        const title = document.getElementById('weight-edit-modal-title');
        const unitEl = document.getElementById('weight-picker-unit');
        const clearBtn = document.getElementById('btn-clear-weight-edit');
        if (!modal || !scrollEl) return;

        const label = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        if (title) title.textContent = dateStr === currentDateString ? 'Log weight · Today' : `Log weight · ${label}`;
        if (unitEl) unitEl.textContent = state.unit === 'metric' ? 'kg' : 'lbs';

        const existing = state.weightHistory[dateStr];
        // ?? (nullish coalescing): use the prior weight only when it exists, else
        // fall through to the default — 0 would be a valid prior, so || won't do.
        const seed = typeof existing === 'number'
            ? existing
            : (nearestPriorWeight(dateStr) ?? (state.unit === 'metric' ? 70 : 150));
        const centerIdx = buildWeightPicker(Math.round(seed * 10) / 10);

        // Only offer "remove" when there's an entry to remove.
        if (clearBtn) clearBtn.style.display = typeof existing === 'number' ? 'block' : 'none';

        modal._editDateStr = dateStr;
        modal.classList.add('active');
        // Defer the scroll: snapping needs the modal to have a resolved layout box,
        // which only happens after .active makes it visible and paints.
        requestAnimationFrame(() => {
            scrollEl.scrollTop = centerIdx * PICKER_ROW_H;
            updateWeightPickerSelection();
        });
    }

    // ===== Event wiring =====
    function setupEventListeners() {
        // Day navigation
        btnPrevDay.addEventListener('click', () => shiftDay(-1));
        btnNextDay.addEventListener('click', () => { if (!btnNextDay.disabled) shiftDay(1); });

        // Calendar popup: click the date title to jump to any past date.
        if (dateTitlesEl) {
            dateTitlesEl.addEventListener('click', openCalendar);
            // The title is role="button"; keep it keyboard-operable.
            dateTitlesEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCalendar(); }
            });
        }
        if (calPrevMonthEl) calPrevMonthEl.addEventListener('click', () => shiftCalendarMonth(-1));
        if (calNextMonthEl) calNextMonthEl.addEventListener('click', () => shiftCalendarMonth(1));

        // Pending-amount wheel: scrolling sets the amount; an In/Out box tap logs it.
        buildPendingWheel();
        if (pendingWheelScrollEl) {
            pendingWheelScrollEl.addEventListener('scroll', () => {
                if (pendingScrollRaf) return;        // collapse a flick's events to one/frame
                pendingScrollRaf = requestAnimationFrame(() => {
                    pendingScrollRaf = 0;
                    let idx = Math.round(pendingWheelScrollEl.scrollLeft / PENDING_ITEM_W);
                    idx = Math.max(0, Math.min((PENDING_MAX / PENDING_STEP), idx));
                    if (idx !== pendingSelectedIdx) markPendingSelected(idx);
                    pendingAmount = idx * PENDING_STEP;   // set directly; don't re-scroll
                    updateMeterHints();
                });
            }, { passive: true });
        }
        setPendingAmount(0);

        // Tapping a meter box logs the pending amount to that meter.
        if (meterInEl) meterInEl.addEventListener('click', () => addEntry('in', pendingAmount));
        if (meterOutEl) meterOutEl.addEventListener('click', () => addEntry('out', pendingAmount));

        // Goal modal (stepper). Goal is a signed daily balance (intake − expenditure):
        // negative = deficit, 0 = maintain, positive = surplus.
        const goalDisplay = document.getElementById('goal-display');
        const goalModalNote = document.getElementById('goal-modal-note');
        let goalVal = state.goalBalance;
        function updateGoalModal() {
            goalDisplay.textContent = signed(goalVal);
            const dir = goalVal > 0 ? 'gain' : goalVal < 0 ? 'lose' : 'maintain';
            if (dir === 'maintain') {
                goalModalNote.textContent = 'A balance of 0 means you eat exactly what you burn — maintaining your weight.';
            } else {
                const isMetric = state.unit === 'metric';
                const divisor = isMetric ? 7700 : 3500;
                const unitName = isMetric ? 'kg' : 'pound';
                const unitNamePlural = isMetric ? 'kg' : 'pounds';
                const weightPerWeek = Math.abs(goalVal * 7 / divisor).toFixed(1);
                const unitString = weightPerWeek === '1.0' ? unitName : unitNamePlural;
                goalModalNote.textContent = `At ${signed(goalVal)} cal/day you can expect to ${dir} ${weightPerWeek} ${unitString} per week.`;
            }
        }
        if (metricGoalEl) {
            metricGoalEl.addEventListener('click', () => {
                goalVal = state.goalBalance;
                updateGoalModal();
                goalModal.classList.add('active');
            });
        }
        document.getElementById('btn-goal-minus-50').addEventListener('click', () => {
            goalVal = Math.max(-GOAL_BALANCE_LIMIT, goalVal - 50);
            updateGoalModal();
        });
        document.getElementById('btn-goal-plus-50').addEventListener('click', () => {
            goalVal = Math.min(GOAL_BALANCE_LIMIT, goalVal + 50);
            updateGoalModal();
        });
        btnCancelGoal.addEventListener('click', () => goalModal.classList.remove('active'));
        btnSaveGoal.addEventListener('click', () => {
            state.goalBalance = goalVal;
            saveState();
            updateUI();
            goalModal.classList.remove('active');
        });

        // BMR+NEAT modal (stepper). A change applies from the viewing day forward,
        // so it edits a dated breakpoint rather than the single global baseline.
        const maintDisplay = document.getElementById('maint-display');
        const maintScopeEl = document.getElementById('maint-modal-scope');
        let maintVal = state.maintenance;
        if (metricMaintEl) {
            metricMaintEl.addEventListener('click', () => {
                maintVal = maintenanceFor(viewingDateString); // seed on the day's current value
                maintDisplay.textContent = maintVal;
                if (maintScopeEl) {
                    const label = new Date(viewingDateString + 'T12:00:00')
                        .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    const when = viewingDateString === currentDateString ? 'today' : label;
                    maintScopeEl.textContent = `Applies from ${when} onward — earlier days keep their value.`;
                }
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
            // Write a breakpoint at the viewing day: that day and every later day
            // (until the next breakpoint) now use this value; earlier days are untouched.
            state.maintenanceHistory[viewingDateString] = maintVal;
            saveState();
            updateUI();
            // The "should-be" curve on the weight tab depends on per-day maintenance.
            const weightTab = document.getElementById('tab-weight');
            if (weightTab && weightTab.classList.contains('active')) renderWeightTab();
            maintModal.classList.remove('active');
        });

        // Close modals on overlay click
        [calendarModal, goalModal, maintModal].forEach((modal) => {
            if (modal) {
                modal.addEventListener('click', (e) => {
                    if (e.target === modal) modal.classList.remove('active');
                });
            }
        });

        // Smooth pulse on the meter values when an entry is logged.
        if (meterInValEl) meterInValEl.style.transition = 'transform 0.15s ease-out';
        if (meterOutValEl) meterOutValEl.style.transition = 'transform 0.15s ease-out';
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
                weightSheetScrollToDate(viewingDateString);
            }
        }

        navTabs.forEach((tab, i) => tab.addEventListener('click', () => switchToTab(i)));
        // (Swipe-to-flip-tabs was removed: it competed with the horizontal scrollers
        //  — the chart strip, weight sheet and amount wheel — for the same gesture.)

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
        const btnSaveWeightEdit = document.getElementById('btn-save-weight-edit');
        const btnCancelWeightEdit = document.getElementById('btn-cancel-weight-edit');
        const btnClearWeightEdit = document.getElementById('btn-clear-weight-edit');
        const pickerScrollEl = document.getElementById('weight-picker-scroll');

        // Update the selected (centered) value as the wheel scrolls. rAF-throttled
        // so a fast flick fires the work once per frame, not per scroll event.
        if (pickerScrollEl) {
            pickerScrollEl.addEventListener('scroll', () => {
                if (pickerScrollRaf) return;
                pickerScrollRaf = requestAnimationFrame(() => {
                    pickerScrollRaf = 0;
                    updateWeightPickerSelection();
                });
            }, { passive: true });
        }

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
                // The selected value is whichever row the wheel is centered on.
                if (dateStr && pickerSelectedIdx >= 0) {
                    const val = pickerValues[pickerSelectedIdx];
                    if (typeof val === 'number' && val >= MIN_WEIGHT && val <= MAX_WEIGHT) {
                        state.weightHistory[dateStr] = val;
                        saveState();
                        refreshWeightSheet();
                        renderWeightTab();
                    }
                }
                weightEditModal.classList.remove('active');
            });
        }
        if (btnCancelWeightEdit) {
            btnCancelWeightEdit.addEventListener('click', () => weightEditModal.classList.remove('active'));
        }
        // The wheel has no empty state, so clearing an entry gets its own button
        // (only shown when the day already has a logged weight).
        if (btnClearWeightEdit) {
            btnClearWeightEdit.addEventListener('click', () => {
                const dateStr = weightEditModal._editDateStr;
                if (dateStr) {
                    delete state.weightHistory[dateStr];
                    saveState();
                    refreshWeightSheet();
                    renderWeightTab();
                }
                weightEditModal.classList.remove('active');
            });
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
