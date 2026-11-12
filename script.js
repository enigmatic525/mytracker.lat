// ===== Pre-app setup (runs before the DOMContentLoaded handler) =====

function showTrackerNotice(message, reason = 'error') {
    const status = document.getElementById('tracker-status');
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
    status.dataset.reason = reason;
}

// Keep a failed operation visible without covering the rest of the tracker.
window.addEventListener('error', () => {
    showTrackerNotice('Something went wrong. Reload the page to try again.');
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
    const APP_VERSION = '1.0.0';
    const defaultGoal = 2000;
    const defaultMaintenance = 2500;
    // The daily intake goal is independent of maintenance and exercise.
    const MIN_GOAL = 500;
    const MAX_GOAL = 10000;
    const MIN_WEIGHT = 1;          // sanity bounds for input validation
    const MAX_WEIGHT = 1500;
    const PROGRESS_MAX_PER_DAY = 6;
    const PROGRESS_MAX_TOTAL = 60;
    const PROGRESS_MAX_DIM = 1100;
    const PROGRESS_JPEG_QUALITY = 0.82;
    // A day's total intake (and, separately, total activity) is capped here. Entries
    // that would push the running total past this are clamped to the remaining room.
    const DAILY_CAL_CAP = 10000;
    const AI_API_URL = /^(?:www\.)?mytracker\.lat$/i.test(window.location.hostname)
        ? 'https://mytracker-lat.vercel.app/api/food'
        : '/api/food';
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
        goal: defaultGoal,
        // `maintenance` is the baseline BMR+NEAT used for days before any dated
        // change. `maintenanceHistory` holds dated breakpoints: editing BMR+NEAT
        // while viewing a day writes a breakpoint there, so the change applies from
        // that day forward without rewriting earlier days. See maintenanceFor().
        maintenance: defaultMaintenance,
        maintenanceHistory: {}, // { 'YYYY-MM-DD': value } — "effective from this date"
        history: {},          // { 'YYYY-MM-DD': [ { id, t:'in'|'out', a } ] }
        weightHistory: {},    // { 'YYYY-MM-DD': weight }
        progressPhotos: {},   // { 'YYYY-MM-DD': [{id, ts, dataUrl}] }
        // A date is considered a lifting day when its array contains at least one
        // entry. Older detailed entries remain valid and appear as filled days.
        liftHistory: {},
        liftCycle: 'single',
        weightAxisSpan: null, // null uses the default automatic Y range
        theme: 'dark',        // 'light' | 'dark'
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
    const aiFoodFormEl = document.getElementById('ai-food-form');
    const aiFoodInputEl = document.getElementById('ai-food-input');
    const aiFoodSubmitEl = document.getElementById('ai-food-submit');
    const aiFoodStatusEl = document.getElementById('ai-food-status');
    const progressPhotoInputEl = document.getElementById('progress-photo-input');
    const progressEmptyEl = document.getElementById('progress-empty');
    const progressGalleryEl = document.getElementById('progress-gallery');
    const progressHeadlineEl = document.getElementById('progress-headline');
    const liftAttendanceGridEl = document.getElementById('lift-attendance-grid');
    const liftMonthLabelEl = document.getElementById('lift-month-label');
    const liftWeekCountEl = document.getElementById('lift-week-count');

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
        const version = document.getElementById('app-version');
        if (version) version.textContent = APP_VERSION;
        loadState();
        setupViewport();
        updateDateElements();
        updateUI();
        setupEventListeners();

    }

    function setupViewport() {
        const sync = () => {
            const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
            if (Number.isFinite(height)) document.documentElement.style.setProperty('--app-height', `${height}px`);
            document.body.classList.toggle('keyboard-open', Number.isFinite(height) && window.innerHeight - height > 150);
        };
        if (window.visualViewport) window.visualViewport.addEventListener('resize', sync);
        window.addEventListener('resize', sync);
        sync();
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

    function isValidDateString(value) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const date = new Date(value + 'T12:00:00');
        return Number.isFinite(date.getTime()) && getDateString(date) === value;
    }

    function readStorage(key) {
        try { return localStorage.getItem(key); } catch (error) {
            showTrackerNotice("Browser storage is unavailable. Entries won't be saved here.", 'storage');
            return null;
        }
    }

    // ===== Persistence =====
    // localStorage is untrusted input: parse defensively and whitelist every field
    // so a corrupt or hand-edited blob can never inject unexpected state.
    function loadState() {
        const saved = readStorage(STORAGE_KEY);
        if (saved) {
            try {
                const p = JSON.parse(saved);
                if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Invalid saved state');
                const maintenance = Number.isFinite(p.maintenance)
                    ? Math.max(500, Math.min(9000, Math.round(p.maintenance))) : defaultMaintenance;
                const maintenanceHistory = sanitizeMaintenanceMap(p.maintenanceHistory);
                // Preserve the effective intake target when upgrading a signed
                // balance goal. Once saved, exercise can no longer move the goal.
                const latest = Object.keys(maintenanceHistory).filter((key) => key <= currentDateString).sort().pop();
                const effectiveMaintenance = latest ? maintenanceHistory[latest] : maintenance;
                const goal = Number.isFinite(p.goal) ? p.goal
                    : Number.isFinite(p.goalBalance) ? effectiveMaintenance + p.goalBalance : defaultGoal;
                state = {
                    goal: Math.max(MIN_GOAL, Math.min(MAX_GOAL, Math.round(goal))),
                    maintenance: maintenance,
                    maintenanceHistory,
                    history: sanitizeHistoryMap(p.history),
                    weightHistory: sanitizeNumberMap(p.weightHistory),
                    progressPhotos: sanitizeProgressPhotosMap(p.progressPhotos),
                    liftHistory: sanitizeLiftHistoryMap(p.liftHistory),
                    liftCycle: p.liftCycle === 'split' ? 'split' : 'single',
                    weightAxisSpan: Number.isFinite(p.weightAxisSpan) && p.weightAxisSpan >= 0.2 && p.weightAxisSpan <= 6000 ? p.weightAxisSpan : null,
                    theme: p.theme === 'light' ? 'light' : 'dark',
                    unit: p.unit === 'metric' ? 'metric' : 'imperial'
                };
                pruneProgressPhotos();
                if (!Number.isFinite(p.goal) && Number.isFinite(p.goalBalance)) {
                    // Preserve the exact original before persisting the goal migration.
                    // If quota prevents a backup, opening an update leaves saved data untouched.
                    try {
                        const backupKey = `${STORAGE_KEY}:before-fixed-goal`;
                        if (!localStorage.getItem(backupKey)) localStorage.setItem(backupKey, saved);
                        saveState();
                    } catch (error) { /* An explicit edit can still save the migrated state later. */ }
                }
            } catch (e) {
                // Corrupt storage — keep the safe defaults rather than crashing.
            }
        } else {
            // Migrate from the v1 storage format if present.
            const oldSaved = readStorage('calorieTrackerState');
            if (oldSaved) {
                try {
                    const old = JSON.parse(oldSaved);
                    if (Number.isFinite(old.goal)) state.goal = Math.max(MIN_GOAL, Math.min(MAX_GOAL, Math.round(old.goal)));
                    if (isValidDateString(old.lastUpdated) && Number.isFinite(old.calories) && old.calories > 0) {
                        state.history[old.lastUpdated] = [{ id: nextEntryId(), t: 'in', a: Math.min(DAILY_CAL_CAP, Math.round(old.calories)) }];
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
                if (isValidDateString(k) && typeof obj[k] === 'number' && isFinite(obj[k])) {
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
                if (isValidDateString(k) && Number.isFinite(obj[k]) && obj[k] >= MIN_WEIGHT && obj[k] <= MAX_WEIGHT) {
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
        const pos = (v) => (Number.isFinite(v) && v > 0 ? Math.min(DAILY_CAL_CAP, Math.round(v)) : 0);
        if (obj && typeof obj === 'object') {
            Object.keys(obj).forEach((k) => {
                if (!isValidDateString(k)) return;
                const v = obj[k];
                const entries = [];
                if (typeof v === 'number') {
                    if (pos(v)) entries.push({ id: nextEntryId(), t: 'in', a: pos(v) });
                } else if (Array.isArray(v)) {
                    v.forEach((e) => {
                        if (e && (e.t === 'in' || e.t === 'out') && pos(e.a)) {
                            const entry = { id: nextEntryId(), t: e.t, a: pos(e.a) };
                            if (typeof e.label === 'string' && e.label.trim()) {
                                entry.label = e.label.trim().slice(0, 80);
                            }
                            entries.push(entry);
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

    // Keep only 'YYYY-MM-DD' -> array of progress photos. Strip invalid
    // entries so a corrupt blob cannot persist garbage.
    function sanitizeProgressPhotosMap(obj) {
        const out = {};
        if (obj && typeof obj === 'object') {
            Object.keys(obj).forEach((k) => {
                if (!isValidDateString(k) || !Array.isArray(obj[k])) return;
                const entries = [];
                obj[k].forEach((e) => {
                    if (!e || typeof e !== 'object') return;
                    if (typeof e.id !== 'string' || !e.id.trim()) return;
                    if (typeof e.dataUrl !== 'string' || !e.dataUrl.startsWith('data:image/')) return;
                    const ts = Number.isFinite(e.ts) ? Math.max(0, Math.floor(e.ts)) : Date.now();
                    entries.push({
                        id: e.id.trim(),
                        ts,
                        dataUrl: e.dataUrl
                    });
                });
                if (entries.length) out[k] = entries.slice(-PROGRESS_MAX_PER_DAY);
            });
        }
        return out;
    }

    function sanitizeLiftHistoryMap(obj) {
        const out = {};
        const groups = new Set(['chest', 'back', 'leg']);
        if (obj && typeof obj === 'object') {
            Object.keys(obj).forEach((day) => {
                if (!isValidDateString(day) || !Array.isArray(obj[day])) return;
                const lifts = [];
                obj[day].forEach((value) => {
                    if (!value || typeof value !== 'object' || !groups.has(value.group)) return;
                    const exercise = typeof value.exercise === 'string' ? value.exercise.trim().slice(0, 80) : '';
                    const sets = Math.round(Number(value.sets));
                    const reps = Math.round(Number(value.reps));
                    const weight = Math.round(Number(value.weight) * 2) / 2;
                    if (!exercise || !Number.isFinite(sets) || sets < 1 || sets > 20) return;
                    if (!Number.isFinite(reps) || reps < 1 || reps > 100) return;
                    if (!Number.isFinite(weight) || weight < 0 || weight > 5000) return;
                    lifts.push({ id: nextEntryId(), group: value.group, exercise, sets, reps, weight });
                });
                if (lifts.length) out[day] = lifts;
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
            const status = document.getElementById('tracker-status');
            if (status && status.dataset.reason === 'storage') showTrackerNotice('');
            return true;
        } catch (error) {
            showTrackerNotice("Changes couldn't be saved. Export a backup in Settings.", 'storage');
            return false;
        }
    }

    async function exportTrackerBackup() {
        const statusEl = document.getElementById('backup-export-status');
        const filename = `mytracker-backup-${getTodayDateString()}.json`;
        const payload = JSON.stringify({
            formatVersion: 2,
            exportedAt: new Date().toISOString(),
            state
        }, null, 2);
        const blob = new Blob([payload], { type: 'application/json' });

        try {
            const file = typeof File === 'function' ? new File([blob], filename, { type: blob.type }) : null;
            if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({ title: 'MyTracker backup', files: [file] });
            } else {
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = filename;
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
            if (statusEl) statusEl.textContent = 'Backup ready. Keep this file private; it contains your tracker history and photos.';
        } catch (error) {
            if (error && error.name === 'AbortError') return;
            console.error('Could not export tracker backup:', error);
            if (statusEl) statusEl.textContent = 'Could not export the backup. Please try again.';
        }
    }

    // ===== Theme & units =====
    function changeUnit(nextUnit) {
        if (!['metric', 'imperial'].includes(nextUnit) || nextUnit === state.unit) return;
        const factor = nextUnit === 'metric' ? 0.45359237 : 1 / 0.45359237;
        // Keep precision in storage; rounding every conversion would slowly
        // change the recorded weight when switching back and forth.
        Object.keys(state.weightHistory).forEach((date) => {
            state.weightHistory[date] *= factor;
        });
        Object.values(state.liftHistory).forEach((entries) => {
            entries.forEach((entry) => { entry.weight *= factor; });
        });
        if (Number.isFinite(state.weightAxisSpan)) state.weightAxisSpan *= factor;
        state.unit = nextUnit;
    }

    function applyThemeAndUnits() {
        document.body.classList.remove('theme-light', 'theme-dark');
        document.body.classList.add(`theme-${state.theme}`);
        const metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme) metaTheme.content = state.theme === 'dark' ? '#191919' : '#ffffff';

        document.querySelectorAll('.theme-mode-toggle').forEach((btn) => {
            const isActive = btn.getAttribute('data-mode') === state.theme;
            btn.classList.toggle('active', isActive);
            btn.classList.toggle('btn-primary', isActive);
            btn.classList.toggle('btn-secondary', !isActive);
            btn.setAttribute('aria-pressed', String(isActive));
        });
        document.querySelectorAll('.unit-toggle').forEach((btn) => {
            const isActive = btn.getAttribute('data-unit') === state.unit;
            btn.classList.toggle('active', isActive);
            btn.classList.toggle('btn-primary', isActive);
            btn.classList.toggle('btn-secondary', !isActive);
            btn.setAttribute('aria-pressed', String(isActive));
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
        const targetIn = state.goal;

        if (metricGoalValEl) metricGoalValEl.textContent = targetIn;
        if (metricGoalEl) metricGoalEl.setAttribute('aria-label', `Daily calorie goal: ${targetIn}. Edit goal.`);
        const goalLabel = document.getElementById('calorie-goal-label');
        if (goalLabel) goalLabel.textContent = `Goal ${targetIn} cal`;
        if (metricMaintValEl) metricMaintValEl.textContent = maint;
        if (metricMaintEl) metricMaintEl.setAttribute('aria-label', `Baseline daily calorie burn: ${maint}. Edit BMR + NEAT.`);
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
            progressBarFill.style.background = day.in > targetIn ? 'var(--danger)' : 'var(--text-primary)';
        }
        const progress = document.getElementById('calorie-progress');
        if (progress) {
            progress.setAttribute('aria-valuemax', targetIn);
            progress.setAttribute('aria-valuenow', Math.min(day.in, targetIn));
            progress.setAttribute('aria-valuetext', `${day.in} of ${targetIn} calories; ${caloriesLeftEl.textContent}`);
        }

        updateMeterHints();
        renderLog();
        renderChart();
        renderProgressTab();
    }

    // Shows a faint "+N" on each meter box reflecting what a tap would log, so the
    // slider amount and its destinations stay visually connected.
    function updateMeterHints() {
        const hint = pendingAmount > 0 ? `Add ${pendingAmount} cal` : '';
        if (meterInHintEl) meterInHintEl.textContent = hint;
        if (meterOutHintEl) meterOutHintEl.textContent = hint;
        if (pendingWheelScrollEl) pendingWheelScrollEl.setAttribute('aria-valuenow', pendingAmount);
        const day = dayData(viewingDateString);
        const action = pendingAmount > 0 ? `Add ${pendingAmount} calories` : 'Select a manual amount below';
        if (meterInEl) meterInEl.setAttribute('aria-label', `Calories in: ${day.in}. ${action} to food.`);
        if (meterOutEl) meterOutEl.setAttribute('aria-label', `Calories out: ${maintenanceFor(viewingDateString) + day.out}. ${action} to exercise.`);

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
            const goalTarget = state.goal;               // fixed daily intake target
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

            // Burn varies by day; the dashed intake goal stays at one fixed level.
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
    function addEntry(type, amount, label, dateStr = viewingDateString) {
        if (!Number.isFinite(amount) || amount <= 0 || !isValidDateString(dateStr)) return 0;
        const status = document.getElementById('tracker-status');
        if (status && status.dataset.reason === 'entry') showTrackerNotice('');
        amount = Math.round(amount);
        if (amount === 0) return 0;
        const t = type === 'out' ? 'out' : 'in';
        // Clamp to the room left under the day's per-type cap. If the day is already
        // at the cap, drop the entry and just reset the slider — nothing to log.
        const current = t === 'out' ? dayData(dateStr).out : dayData(dateStr).in;
        const room = DAILY_CAL_CAP - current;
        if (room <= 0) {
            setPendingAmount(0);
            if (!label) showTrackerNotice('Daily calorie limit reached. No entry added.', 'entry');
            return 0;
        }
        const entries = getEntries(dateStr).slice();
        const entry = { id: nextEntryId(), t: t, a: Math.min(room, amount) };
        if (typeof label === 'string' && label.trim()) entry.label = label.trim().slice(0, 80);
        entries.push(entry);
        state.history[dateStr] = entries;

        const saved = saveState();
        setPendingAmount(0); // reset the slider so the same tap can't double-log
        updateUI();
        if (!label && saved && entry.a < amount) {
            showTrackerNotice(`Added ${entry.a} of ${amount} calories; daily limit reached.`, 'entry');
        }
        return entry.a;
    }

    // Round item rows together, so their integers still add up to the estimate.
    function estimateRows(result, fallbackLabel) {
        if (!Array.isArray(result.breakdown) || !result.breakdown.length) {
            return [{ label: fallbackLabel, calories: result.calories }];
        }
        if (result.breakdown.length > 20) throw new Error('Too many items in the estimate');
        const rows = result.breakdown.map((item) => {
            if (!item || typeof item.label !== 'string' || !item.label.trim() || !Number.isFinite(item.calories) || item.calories < 0) {
                throw new Error('Invalid item in the estimate');
            }
            return { label: item.label.trim().slice(0, 80), calories: item.calories };
        });
        const total = rows.reduce((sum, row) => sum + row.calories, 0);
        if (Math.abs(total - result.calories) > 0.6) throw new Error('Item calories do not match the estimate');
        const rounded = rows.map((row) => ({ ...row, calories: Math.floor(row.calories) }));
        const order = rows.map((row, index) => ({ index, fraction: row.calories - Math.floor(row.calories) }))
            .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
        let remainder = result.calories - rounded.reduce((sum, row) => sum + row.calories, 0);
        if (remainder < 0 || remainder > rows.length) throw new Error('Invalid item calorie total');
        for (let i = 0; i < remainder; i++) rounded[order[i].index].calories += 1;
        return rounded;
    }

    function addEstimatedEntries(result, label, dateStr) {
        const type = result.category === 'exercise' ? 'out' : 'in';
        const rows = estimateRows(result, label);
        let room = Math.max(0, DAILY_CAL_CAP - dayData(dateStr)[type]);
        const entries = [];
        for (const row of rows) {
            const amount = Math.min(room, row.calories);
            if (amount > 0) entries.push({ id: nextEntryId(), t: type, a: amount, label: row.label });
            room -= amount;
        }
        const added = entries.reduce((sum, entry) => sum + entry.a, 0);
        if (entries.length) {
            // The log shows newest first; preserve the order of a single AI list.
            state.history[dateStr] = getEntries(dateStr).concat(entries.reverse());
            saveState();
            setPendingAmount(0);
            updateUI();
        }
        return added;
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

            const main = document.createElement('span');
            main.className = 'log-main';

            const amt = document.createElement('span');
            amt.className = 'log-amount';
            amt.textContent = `${type === 'out' ? '−' : '+'}${e.a}`;
            main.appendChild(amt);

            if (e.label) {
                const label = document.createElement('span');
                label.className = 'log-label';
                label.textContent = e.label;
                label.title = e.label;
                main.appendChild(label);
            }

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'log-delete';
            del.setAttribute('aria-label', `Remove ${type === 'out' ? 'calories out' : 'calories in'} ${e.a}`);
            del.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
            del.addEventListener('click', () => deleteEntry(e.id));

            item.appendChild(main);
            item.appendChild(del);
            listEl.appendChild(item);
        });
    }

    // ===== Progress photos =====
    function getProgressEntries(dateStr) {
        const v = state.progressPhotos[dateStr];
        return Array.isArray(v) ? v : [];
    }

    function setProgressEntries(dateStr, entries) {
        const cleaned = Array.isArray(entries) ? entries : [];
        if (cleaned.length) {
            state.progressPhotos[dateStr] = cleaned;
        } else {
            delete state.progressPhotos[dateStr];
        }
    }

    // Keep only the most recent entries if the total local store grows too large.
    function pruneProgressPhotos() {
        const all = [];
        Object.keys(state.progressPhotos).forEach((dateStr) => {
            getProgressEntries(dateStr).forEach((entry) => {
                all.push({ dateStr, id: entry.id, ts: entry.ts || 0 });
            });
        });
        all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        if (all.length <= PROGRESS_MAX_TOTAL) return;

        const keep = new Set(all.slice(0, PROGRESS_MAX_TOTAL).map((p) => `${p.dateStr}:${p.id}`));
        Object.keys(state.progressPhotos).forEach((dateStr) => {
            const next = getProgressEntries(dateStr).filter((entry) => keep.has(`${dateStr}:${entry.id}`));
            setProgressEntries(dateStr, next);
        });
    }

    // Reads an image file, decodes it, and returns a compact JPEG data URL.
    function compressImageToDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const source = document.createElement('img');
                source.onload = () => {
                    const maxSide = Math.max(source.naturalWidth, source.naturalHeight);
                    const ratio = maxSide > PROGRESS_MAX_DIM ? PROGRESS_MAX_DIM / maxSide : 1;
                    const w = Math.max(1, Math.round(source.naturalWidth * ratio));
                    const h = Math.max(1, Math.round(source.naturalHeight * ratio));
                    const canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        reject(new Error('Could not initialize image canvas'));
                        return;
                    }
                    ctx.drawImage(source, 0, 0, w, h);
                    const out = canvas.toDataURL('image/jpeg', PROGRESS_JPEG_QUALITY);
                    resolve(out);
                };
                source.onerror = () => reject(new Error('Could not decode image'));
                source.src = reader.result;
            };
            reader.onerror = () => reject(new Error('Could not read image'));
            reader.readAsDataURL(file);
        });
    }

    function addProgressPhoto(dateStr, dataUrl) {
        const dayList = getProgressEntries(dateStr).slice();
        dayList.push({
            id: nextEntryId(),
            ts: Date.now(),
            dataUrl
        });
        setProgressEntries(dateStr, dayList.slice(-PROGRESS_MAX_PER_DAY));
        pruneProgressPhotos();
    }

    function deleteProgressPhoto(dateStr, id) {
        const next = getProgressEntries(dateStr).filter((p) => p.id !== id);
        setProgressEntries(dateStr, next);
        saveState();
        renderProgressTab();
    }

    // Builds a horizontal strip that includes every stored photo (latest first).
    function renderProgressTab() {
        if (!progressGalleryEl || !progressEmptyEl || !progressHeadlineEl) return;

        const allEntries = [];
        Object.keys(state.progressPhotos).forEach((dateStr) => {
            const list = getProgressEntries(dateStr);
            list.forEach((entry) => {
                allEntries.push({
                    dateStr,
                    id: entry.id,
                    ts: entry.ts || 0,
                    dataUrl: entry.dataUrl
                });
            });
        });
        allEntries.sort((a, b) => (b.ts || 0) - (a.ts || 0));

        progressHeadlineEl.textContent = allEntries.length ? `${allEntries.length} photo${allEntries.length === 1 ? '' : 's'}` : '';

        progressGalleryEl.innerHTML = '';
        if (!allEntries.length) {
            progressEmptyEl.style.display = 'block';
        } else {
            progressEmptyEl.style.display = 'none';
            allEntries.forEach((entry) => {
                const card = document.createElement('article');
                card.className = 'progress-photo-item';
                card.dataset.date = entry.dateStr;

                const link = document.createElement('a');
                link.href = entry.dataUrl;
                link.target = '_blank';
                link.rel = 'noreferrer';
                link.setAttribute('aria-label', `Open progress photo from ${entry.dateStr}`);

                const img = document.createElement('img');
                img.loading = 'lazy';
                img.src = entry.dataUrl;
                img.alt = 'Progress photo';
                link.appendChild(img);

                const meta = document.createElement('div');
                meta.className = 'progress-photo-meta';

                const caption = document.createElement('span');
                caption.className = 'progress-photo-caption';
                const dt = new Date(entry.ts || Date.now());
                caption.textContent = `${new Date(entry.dateStr + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
                caption.title = caption.textContent;

                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'progress-photo-delete';
                del.setAttribute('aria-label', 'Delete photo');
                del.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
                del.dataset.id = entry.id;
                del.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    deleteProgressPhoto(entry.dateStr, entry.id);
                });

                meta.appendChild(caption);
                card.appendChild(link);
                card.appendChild(meta);
                card.appendChild(del);
                progressGalleryEl.appendChild(card);
            });
        }
    }

    async function handleProgressPhotoSelection(fileList) {
        if (!progressPhotoInputEl || !progressPhotoInputEl.files) return;

        const files = Array.from(fileList).filter((f) => typeof f?.type === 'string' && f.type.startsWith('image/'));
        if (!files.length) return;
        const entryDate = viewingDateString;
        progressPhotoInputEl.disabled = true;
        let added = 0;
        let failed = 0;
        try {
            for (const file of files) {
                try {
                    const dataUrl = await compressImageToDataUrl(file);
                    addProgressPhoto(entryDate, dataUrl);
                    added += 1;
                } catch (error) {
                    failed += 1;
                }
            }
            const saved = added ? saveState() : true;
            renderProgressTab();
            if (failed && saved) {
                showTrackerNotice(`${added ? `${added} photo${added === 1 ? '' : 's'} added. ` : ''}${failed} could not be opened. Try a different image.`, 'photos');
            } else if (saved) {
                const status = document.getElementById('tracker-status');
                if (status && status.dataset.reason === 'photos') showTrackerNotice('');
            }
            progressPhotoInputEl.value = '';
        } finally {
            progressPhotoInputEl.disabled = false;
        }
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
            const item = document.createElement('div');
            item.className = 'hwheel-item';
            item.textContent = v;
            // Jump instantly (no smooth animation) so rapid taps each register
            // right away: tapping the far edge centers that value, which shifts the
            // next-higher value under your finger — tap the edge 5× to reach +500.
            item.addEventListener('click', () => setPendingAmount(v));
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

    function setupManualSwipes() {
        const wheel = document.getElementById('pending-wheel');
        if (!wheel || !pendingWheelScrollEl) return;
        const movingNumber = document.createElement('div');
        movingNumber.className = 'hwheel-drag-number';
        movingNumber.setAttribute('aria-hidden', 'true');
        movingNumber.hidden = true;
        wheel.appendChild(movingNumber);
        let gesture = null;
        let suppressClick = false;
        let suppressClickTimer = null;
        let settleTimer = null;
        const hiddenItems = new Map();
        const clearVisual = () => {
            clearTimeout(settleTimer);
            settleTimer = null;
            movingNumber.hidden = true;
            movingNumber.style.setProperty('--swipe-offset', '0px');
            hiddenItems.forEach((visibility, item) => { item.style.visibility = visibility; });
            hiddenItems.clear();
        };
        const hideSelected = () => {
            const item = pendingWheelScrollEl.children[pendingSelectedIdx];
            if (!item || hiddenItems.has(item)) return;
            hiddenItems.set(item, item.style.visibility || '');
            item.style.visibility = 'hidden';
        };
        const reset = (animate = false) => {
            gesture = null;
            wheel.classList.remove('is-swiping');
            if (animate && !movingNumber.hidden) {
                movingNumber.style.setProperty('--swipe-offset', '0px');
                settleTimer = setTimeout(clearVisual, 180);
            } else clearVisual();
        };
        wheel.addEventListener('pointerdown', (event) => {
            reset();
            clearTimeout(suppressClickTimer);
            suppressClick = false;
            if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
            // Read the actual wheel position in case its last scroll frame is pending.
            const index = Math.max(0, Math.min(PENDING_MAX / PENDING_STEP,
                Math.round(pendingWheelScrollEl.scrollLeft / PENDING_ITEM_W)));
            const amount = index * PENDING_STEP;
            if (!amount) return;
            pendingAmount = amount;
            markPendingSelected(index);
            updateMeterHints();
            gesture = { id: event.pointerId, x: event.clientX, y: event.clientY,
                amount, date: viewingDateString, intent: null };
        });
        wheel.addEventListener('pointermove', (event) => {
            if (!gesture || event.pointerId !== gesture.id) return;
            const dx = event.clientX - gesture.x;
            const dy = event.clientY - gesture.y;
            if (!gesture.intent && Math.max(Math.abs(dx), Math.abs(dy)) >= 10) {
                if (Math.abs(dy) > Math.abs(dx) * 1.3) {
                    gesture.intent = 'vertical';
                    if (typeof wheel.setPointerCapture === 'function') wheel.setPointerCapture(event.pointerId);
                } else if (Math.abs(dx) >= Math.abs(dy)) gesture.intent = 'horizontal';
            }
            if (gesture.intent !== 'vertical') return;
            event.preventDefault();
            if (movingNumber.hidden) {
                movingNumber.textContent = gesture.amount;
                movingNumber.hidden = false;
                wheel.classList.add('is-swiping');
                hideSelected();
            }
            // No easing while held: one pixel of finger travel moves one pixel of text.
            movingNumber.style.setProperty('--swipe-offset', `${dy}px`);
        }, { passive: false });
        wheel.addEventListener('pointerup', (event) => {
            if (!gesture || event.pointerId !== gesture.id) return;
            const entry = gesture;
            const dx = event.clientX - entry.x;
            const dy = event.clientY - entry.y;
            const commit = entry.intent !== 'horizontal' && Math.abs(dy) >= 32 && Math.abs(dy) > Math.abs(dx) * 1.3;
            reset(true);
            if (!commit) return;
            event.preventDefault();
            suppressClick = true;
            suppressClickTimer = setTimeout(() => { suppressClick = false; }, 350);
            addEntry(dy < 0 ? 'in' : 'out', entry.amount, undefined, entry.date);
            if (!movingNumber.hidden) hideSelected();
        });
        const cancel = () => { if (gesture) reset(true); };
        wheel.addEventListener('pointercancel', cancel);
        wheel.addEventListener('lostpointercapture', (event) => {
            // Touch starts with implicit capture on the item. When the wheel
            // takes capture, that item's loss event bubbles here; it is a handoff,
            // not a cancelled swipe. Only losing the wheel's own capture cancels.
            if (event.target === wheel && gesture && event.pointerId === gesture.id) cancel();
        });
        wheel.addEventListener('keydown', clearVisual);
        // A release click must not select the old item after logging reset the wheel.
        wheel.addEventListener('click', (event) => {
            if (!suppressClick) return;
            suppressClick = false;
            event.preventDefault();
            event.stopPropagation();
            if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        }, true);
    }

    // ===== Navigation between days / dates =====
    function clearEntryFeedback() {
        const status = document.getElementById('tracker-status');
        if (status && status.dataset.reason === 'entry') showTrackerNotice('');
        if (aiFoodStatusEl && aiFoodFormEl && aiFoodFormEl.getAttribute('aria-busy') !== 'true') {
            aiFoodStatusEl.hidden = true;
            const details = document.getElementById('ai-estimate-details');
            if (details) details.hidden = true;
        }
    }

    function shiftDay(delta) {
        const d = new Date(viewingDateString + 'T12:00:00');
        d.setDate(d.getDate() + delta);
        const next = getDateString(d);
        if (next > currentDateString) return; // never navigate into the future
        viewingDateString = next;
        clearEntryFeedback();
        updateDateElements();
        refreshActiveView();
    }

    function jumpToDate(dateStr) {
        if (!isValidDateString(dateStr)) return;
        if (dateStr > currentDateString) dateStr = currentDateString;
        viewingDateString = dateStr;
        clearEntryFeedback();
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
            return;
        }
        const progressTab = document.getElementById('tab-progress');
        if (progressTab && progressTab.classList.contains('active')) {
            renderProgressTab();
            return;
        }
        const liftsTab = document.getElementById('tab-lifts');
        if (liftsTab && liftsTab.classList.contains('active')) {
            renderLiftsTab();
        }
    }

    // ===== Lift attendance tab =====
    // Weeks run Monday through Sunday. Detailed legacy lift entries are intentionally
    // treated as attendance so upgrading does not erase previously recorded days.
    function liftWeekFor(dateStr) {
        const date = new Date(dateStr + 'T12:00:00');
        const daysSinceMonday = (date.getDay() + 6) % 7;
        const start = new Date(date);
        start.setDate(start.getDate() - daysSinceMonday);
        const end = new Date(start);
        end.setDate(end.getDate() + 6);
        return { start: getDateString(start), end: getDateString(end), startDate: start, endDate: end };
    }

    function renderLiftsTab() {
        if (!liftAttendanceGridEl || !liftMonthLabelEl || !liftWeekCountEl) return;
        const today = new Date(viewingDateString + 'T12:00:00');
        const year = today.getFullYear();
        const month = today.getMonth();
        const firstDay = new Date(year, month, 1, 12);
        const daysInMonth = new Date(year, month + 1, 0, 12).getDate();

        liftMonthLabelEl.textContent = today.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        liftAttendanceGridEl.innerHTML = '';

        ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach((weekday) => {
            const heading = document.createElement('span');
            heading.className = 'lift-attendance-weekday';
            heading.textContent = weekday;
            liftAttendanceGridEl.appendChild(heading);
        });

        for (let blank = 0; blank < firstDay.getDay(); blank += 1) {
            const spacer = document.createElement('span');
            spacer.className = 'lift-attendance-blank';
            spacer.setAttribute('aria-hidden', 'true');
            liftAttendanceGridEl.appendChild(spacer);
        }

        for (let dateNumber = 1; dateNumber <= daysInMonth; dateNumber += 1) {
            const date = new Date(year, month, dateNumber, 12);
            const day = getDateString(date);
            const groups = liftGroupsFor(day);
            const completed = groups.length > 0;
            const status = completed ? groups.map(liftGroupLabel).join(' / ') : 'no lift';
            const label = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = `lift-attendance-day${completed ? ` ${groups.join(' ')}${groups.length > 1 ? ' split' : ''}` : ''}${day === currentDateString ? ' today' : ''}`;
            cell.textContent = String(dateNumber);
            if (completed) {
                const kind = document.createElement('span');
                kind.className = 'lift-attendance-kind';
                kind.textContent = groups.map(liftGroupLabel).join('/');
                cell.appendChild(kind);
            }
            cell.title = `${label}: ${status}${day === currentDateString ? ' (today)' : ''}`;
            cell.setAttribute('aria-label', `${label}${day === currentDateString ? ', today' : ''}, ${status}`);
            cell.setAttribute('aria-pressed', completed ? 'true' : 'false');
            cell.addEventListener('click', () => cycleLiftDay(day));
            liftAttendanceGridEl.appendChild(cell);
        }

        const week = liftWeekFor(viewingDateString);
        const completedThisWeek = Object.keys(state.liftHistory).filter((day) => (
            day >= week.start && day <= week.end && Array.isArray(state.liftHistory[day]) && state.liftHistory[day].length > 0
        )).length;
        liftWeekCountEl.textContent = `${completedThisWeek}/7`;
        const hint = document.getElementById('lift-cycle-hint');
        if (hint) hint.textContent = state.liftCycle === 'split' ? 'Chest/Back → Back/Legs → Legs/Chest → Clear. Hold to change.' : 'Chest → Back → Legs → Clear. Hold to change.';
    }

    function liftGroupsFor(day) {
        return [...new Set((state.liftHistory[day] || []).map((entry) => entry.group))]
            .filter((group) => ['chest', 'back', 'leg'].includes(group));
    }
    function liftGroupLabel(group) { return group === 'leg' ? 'Legs' : group === 'back' ? 'Back' : 'Chest'; }

    function cycleLiftDay(day) {
        const cycle = state.liftCycle === 'split'
            ? [['chest', 'back'], ['back', 'leg'], ['leg', 'chest']]
            : [['chest'], ['back'], ['leg']];
        const key = (groups) => groups.slice().sort().join('+');
        const index = cycle.findIndex((groups) => key(groups) === key(liftGroupsFor(day)));
        const next = index === cycle.length - 1 ? null : cycle[index + 1];
        if (!next) delete state.liftHistory[day];
        else state.liftHistory[day] = next.map((group) => ({
            id: nextEntryId(), group, exercise: 'Workout', sets: 1, reps: 1, weight: 0
        }));
        saveState();
        renderLiftsTab();
    }

    function setLiftCycle(mode) {
        state.liftCycle = mode === 'split' ? 'split' : 'single';
        saveState();
        renderLiftsTab();
    }

    function setupLiftControls() {
        const card = document.getElementById('lift-attendance-card');
        const modal = document.getElementById('lift-cycle-modal');
        if (!card || !modal) return;
        const choices = Array.from(document.querySelectorAll('input[name="lift-cycle"]'));
        const open = () => {
            choices.forEach((input) => { input.checked = input.value === state.liftCycle; });
            modal.classList.add('active');
        };
        document.getElementById('btn-lift-cycle').addEventListener('click', open);
        document.getElementById('btn-cancel-lift-cycle').addEventListener('click', () => modal.classList.remove('active'));
        document.getElementById('btn-save-lift-cycle').addEventListener('click', () => {
            const selected = choices.find((input) => input.checked);
            if (selected) setLiftCycle(selected.value);
            modal.classList.remove('active');
        });
        let timer = null;
        let held = false;
        let origin = null;
        const cancel = () => { clearTimeout(timer); timer = null; };
        card.addEventListener('pointerdown', (event) => {
            if (event.button !== undefined && event.button !== 0) return;
            if (event.isPrimary === false) return;
            cancel();
            held = false;
            origin = { x: event.clientX, y: event.clientY };
            timer = setTimeout(() => { held = true; open(); }, 550);
        });
        card.addEventListener('pointermove', (event) => {
            if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) cancel();
        });
        card.addEventListener('pointerup', () => {
            cancel(); origin = null;
            setTimeout(() => { held = false; }, 100);
        });
        card.addEventListener('pointercancel', () => { cancel(); held = false; origin = null; });
        card.addEventListener('pointerleave', cancel);
        card.addEventListener('click', (event) => {
            if (held) {
                event.preventDefault();
                event.stopPropagation();
                if (event.stopImmediatePropagation) event.stopImmediatePropagation();
                held = false;
            }
        }, true);
        card.addEventListener('contextmenu', (event) => { event.preventDefault(); cancel(); held = true; open(); });
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

    function weightAxisBounds(min, max, customSpan = null) {
        const padding = Math.max((max - min) * 0.2, 1);
        const span = Number.isFinite(customSpan) && customSpan >= 0.2 ? customSpan : (max - min + padding * 2) * 2;
        const lower = Math.max(0, (min + max) / 2 - span / 2);
        return { min: lower, max: lower + span };
    }

    function setWeightAxisSpan(value) {
        if (value !== null && (!Number.isFinite(value) || value < 0.2 || value > 6000)) return false;
        state.weightAxisSpan = value;
        saveState();
        renderWeightTab();
        return true;
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
        const unitName = state.unit === 'metric' ? 'kg' : 'lbs';
        const latestDate = Object.keys(state.weightHistory).filter((date) => date <= viewingDateString).sort().pop();
        const value = document.getElementById('weight-current-value');
        const label = document.getElementById('weight-current-label');
        if (value) value.textContent = latestDate ? state.weightHistory[latestDate].toFixed(1) : '—';
        if (label) label.textContent = latestDate && latestDate !== viewingDateString
            ? new Date(latestDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        const unit = document.getElementById('weight-current-unit');
        if (unit) unit.textContent = unitName;
        const logButton = document.getElementById('btn-weight-log');
        if (logButton) logButton.textContent = latestDate === viewingDateString ? 'Edit weight' : 'Log weight';
        const axisUnit = document.getElementById('weight-axis-unit');
        if (axisUnit) axisUnit.textContent = unitName;


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
            const scaleInput = document.getElementById('weight-axis-span');
            if (scaleInput) {
                scaleInput.value = state.weightAxisSpan === null ? '' : state.weightAxisSpan;
                scaleInput.placeholder = 'Auto';
            }
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
        const bounds = weightAxisBounds(minW, maxW, state.weightAxisSpan);
        minW = bounds.min;
        maxW = bounds.max;
        const yRange = maxW - minW;
        const scaleInput = document.getElementById('weight-axis-span');
        if (scaleInput && document.activeElement !== scaleInput) scaleInput.value = Math.round(yRange * 10) / 10;

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
        if (dateStr > currentDateString) {
            cell.classList.add('future');
            cell.disabled = true;
        }
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
            cell.classList.toggle('today', cell.dataset.date === currentDateString);
            cell.classList.toggle('future', cell.dataset.date > currentDateString);
            cell.disabled = cell.dataset.date > currentDateString;
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
        scrollEl.setAttribute('aria-valuenow', pickerValues[idx]);
        scrollEl.setAttribute('aria-valuetext', `${pickerValues[idx].toFixed(1)} ${state.unit === 'metric' ? 'kg' : 'lb'}`);
        const input = document.getElementById('weight-value-input');
        if (input) {
            input.value = pickerValues[idx].toFixed(1);
            input.dataset.edited = 'false';
        }
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
        const input = document.getElementById('weight-value-input');
        if (input) {
            input.value = seed.toFixed(1);
            input.setAttribute('aria-label', `Weight in ${state.unit === 'metric' ? 'kilograms' : 'pounds'}`);
            input.min = MIN_WEIGHT;
            input.max = MAX_WEIGHT;
            input.dataset.edited = 'false';
            if (typeof input.setCustomValidity === 'function') input.setCustomValidity('');
        }
        scrollEl.setAttribute('aria-valuemin', pickerValues[0]);
        scrollEl.setAttribute('aria-valuemax', pickerValues[pickerValues.length - 1]);

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
        // A pinned tab may stay open overnight. Follow the new day only when
        // the user was viewing today; preserve a deliberately selected past day.
        function syncToday() {
            const today = getTodayDateString();
            if (today === currentDateString) return;
            if (viewingDateString === currentDateString) viewingDateString = today;
            currentDateString = today;
            updateDateElements();
            refreshWeightSheet();
            refreshActiveView();
        }
        window.addEventListener('focus', syncToday);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) syncToday();
        });
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
        setupManualSwipes();

        // Natural-language calorie entry. The server owns the OpenAI credential,
        // classifies food vs. exercise, and returns a compact estimate.
        let isAiSubmitting = false;
        function setAiFoodStatus(message, type) {
            if (!aiFoodStatusEl) return;
            aiFoodStatusEl.textContent = message;
            aiFoodStatusEl.classList.toggle('error', type === 'error');
            aiFoodStatusEl.hidden = !message;
            const details = document.getElementById('ai-estimate-details');
            if (details) { details.hidden = true; details.open = false; }
        }

        async function submitAiFoodEntry() {
            if (isAiSubmitting) return;
            const entry = aiFoodInputEl ? aiFoodInputEl.value.trim() : '';
            if (!entry || !aiFoodSubmitEl) return;
            const entryDate = viewingDateString;
            const weightDates = Object.keys(state.weightHistory).filter((date) => date <= entryDate).sort();
            const weight = state.weightHistory[weightDates[weightDates.length - 1]];
            const convertedWeight = Number.isFinite(weight) ? weight * (state.unit === 'metric' ? 1 : 0.45359237) : NaN;
            const weightKg = convertedWeight >= 1 && convertedWeight <= 680 ? convertedWeight : undefined;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 35000);

            isAiSubmitting = true;
            aiFoodSubmitEl.disabled = true;
            aiFoodSubmitEl.textContent = 'Adding…';
            if (aiFoodInputEl) aiFoodInputEl.disabled = true;
            if (aiFoodFormEl) aiFoodFormEl.setAttribute('aria-busy', 'true');
            setAiFoodStatus('Estimating calories…');

            try {
                const response = await fetch(AI_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ entry, weightKg }),
                    signal: controller.signal
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(result.error || 'Could not estimate calories');
                if (!Number.isInteger(result.calories) || result.calories < 0 || result.calories > DAILY_CAL_CAP) {
                    throw new Error('No calorie estimate returned');
                }

                const entryType = result.category === 'exercise' ? 'out' :
                    result.category === 'food' ? 'in' : '';
                if (!entryType) throw new Error('No entry category returned');

                const label = typeof result.label === 'string' && result.label.trim() ? result.label.trim() : entry;
                const added = result.calories > 0 ? addEstimatedEntries(result, label, entryDate) : 0;
                if (result.calories > 0 && !added) {
                    throw new Error('Daily 10,000-calorie limit reached. No entry added.');
                }
                if (aiFoodInputEl) aiFoodInputEl.value = '';
                const assumptions = Array.isArray(result.assumptions)
                    ? result.assumptions.filter((value) => typeof value === 'string').join(' ') : '';
                // Successful entries are visible in their columns, without a second receipt.
                const message = result.calories === 0 ? `${label}: 0 calories.`
                    : added < result.calories ? `Daily limit: only ${added} of ${result.calories} calories were logged.` : '';
                setAiFoodStatus(message, added < result.calories ? 'error' : 'success');
                const notes = document.getElementById('ai-estimate-notes');
                const details = document.getElementById('ai-estimate-details');
                if (notes && details) {
                    notes.textContent = assumptions;
                    details.hidden = !notes.textContent;
                }
            } catch (error) {
                console.error('Could not estimate calorie entry:', error);
                setAiFoodStatus(error.name === 'AbortError' ? 'Estimate timed out. Try again with a specific quantity or duration.'
                    : error.message || 'Could not estimate that entry right now.', 'error');
            } finally {
                clearTimeout(timeout);
                isAiSubmitting = false;
                aiFoodSubmitEl.disabled = false;
                aiFoodSubmitEl.textContent = 'Add';
                if (aiFoodFormEl) aiFoodFormEl.setAttribute('aria-busy', 'false');
                if (aiFoodInputEl) {
                    aiFoodInputEl.disabled = false;
                }
            }
        }

        if (aiFoodFormEl) {
            aiFoodFormEl.addEventListener('submit', (e) => {
                e.preventDefault();
                submitAiFoodEntry();
            });
        }
        // The native form submit event handles button, touch and Enter once.

        if (progressPhotoInputEl) {
            progressPhotoInputEl.addEventListener('change', (e) => {
                if (!e.target.files) return;
                handleProgressPhotoSelection(e.target.files);
            });
        }

        // Goal modal: edit an absolute daily intake target in 50-calorie steps.
        const goalDisplay = document.getElementById('goal-display');
        const goalModalNote = document.getElementById('goal-modal-note');
        let goalVal = state.goal;
        function updateGoalModal() {
            goalDisplay.textContent = goalVal;
            goalModalNote.textContent = 'Daily intake target. Exercise does not change it.';
            document.getElementById('btn-goal-minus-50').disabled = goalVal <= MIN_GOAL;
            document.getElementById('btn-goal-plus-50').disabled = goalVal >= MAX_GOAL;
        }
        if (metricGoalEl) {
            metricGoalEl.addEventListener('click', () => {
                goalVal = state.goal;
                updateGoalModal();
                goalModal.classList.add('active');
            });
        }
        document.getElementById('btn-goal-minus-50').addEventListener('click', () => {
            goalVal = Math.max(MIN_GOAL, goalVal - 50);
            updateGoalModal();
        });
        document.getElementById('btn-goal-plus-50').addEventListener('click', () => {
            goalVal = Math.min(MAX_GOAL, goalVal + 50);
            updateGoalModal();
        });
        btnCancelGoal.addEventListener('click', () => goalModal.classList.remove('active'));
        btnSaveGoal.addEventListener('click', () => {
            state.goal = goalVal;
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

        setupTabsSettingsAndWeight();
        setupLiftControls();
        setupAccessibleControls();
    }

    function setupAccessibleControls() {
        document.querySelectorAll('[role="button"]').forEach((control) => {
            // The date title already has its own keyboard handler.
            if (control === dateTitlesEl) return;
            control.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    control.click();
                }
            });
        });
        if (pendingWheelScrollEl) {
            pendingWheelScrollEl.tabIndex = 0;
            pendingWheelScrollEl.setAttribute('role', 'slider');
            pendingWheelScrollEl.setAttribute('aria-orientation', 'horizontal');
            pendingWheelScrollEl.setAttribute('aria-label', 'Calories to add');
            pendingWheelScrollEl.setAttribute('aria-valuemin', '0');
            pendingWheelScrollEl.setAttribute('aria-valuemax', PENDING_MAX);
            pendingWheelScrollEl.setAttribute('aria-valuenow', pendingAmount);
            pendingWheelScrollEl.addEventListener('keydown', (event) => {
                if (event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                    event.preventDefault();
                    addEntry(event.key === 'ArrowUp' ? 'in' : 'out', pendingAmount);
                    return;
                }
                const steps = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
                if (event.key in steps || event.key === 'Home' || event.key === 'End') {
                    event.preventDefault();
                    setPendingAmount(event.key === 'Home' ? 0 : event.key === 'End' ? PENDING_MAX
                        : pendingAmount + steps[event.key] * PENDING_STEP);
                }
            });
        }

        const modals = Array.from(document.querySelectorAll('.modal-overlay'));
        let activeModal = null;
        let returnFocus = null;
        const focusable = (modal) => Array.from(modal.querySelectorAll('button, input, [tabindex="0"]'))
            .filter((element) => !element.disabled && element.getClientRects().length > 0);
        const syncModal = () => {
            const next = modals.find((modal) => modal.classList.contains('active')) || null;
            if (next === activeModal) return;
            if (next) {
                if (!activeModal) returnFocus = document.activeElement;
                activeModal = next;
                (focusable(next)[0] || next).focus();
            } else {
                activeModal = null;
                if (returnFocus && returnFocus.isConnected) returnFocus.focus();
            }
        };
        const observer = new MutationObserver(syncModal);
        modals.forEach((modal) => observer.observe(modal, { attributes: true, attributeFilter: ['class'] }));
        document.addEventListener('keydown', (event) => {
            if (!activeModal) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                activeModal.classList.remove('active');
            } else if (event.key === 'Tab') {
                const controls = focusable(activeModal);
                const first = controls[0] || activeModal;
                const last = controls[controls.length - 1] || activeModal;
                if (!activeModal.contains(document.activeElement) ||
                    (event.shiftKey && document.activeElement === first) ||
                    (!event.shiftKey && document.activeElement === last)) {
                    event.preventDefault();
                    (event.shiftKey ? last : first).focus();
                }
            }
        });
        syncModal();
    }

    function setupTabsSettingsAndWeight() {
        const navTabs = Array.from(document.querySelectorAll('.nav-tab'));
        const tabPanes = document.querySelectorAll('.tab-pane');

        function switchToTab(index) {
            const clamped = Math.max(0, Math.min(navTabs.length - 1, index));
            const oldIdx = navTabs.findIndex((t) => t.classList.contains('active'));
            if (oldIdx === clamped) return;

            navTabs.forEach((t, index) => {
                t.classList.remove('active');
                t.setAttribute('aria-pressed', String(index === clamped));
            });
            navTabs[clamped].classList.add('active');
            tabPanes.forEach((pane) => pane.classList.remove('active'));
            const newPane = document.getElementById(navTabs[clamped].getAttribute('data-target'));
            newPane.classList.add('active');

            if (navTabs[clamped].getAttribute('data-target') === 'tab-weight') {
                renderWeightTab();
                refreshWeightSheet();
                weightSheetScrollToDate(viewingDateString);
            } else if (navTabs[clamped].getAttribute('data-target') === 'tab-progress') {
                renderProgressTab();
            } else if (navTabs[clamped].getAttribute('data-target') === 'tab-lifts') {
                renderLiftsTab();
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
        const exportBackupBtn = document.getElementById('btn-export-backup');
        if (exportBackupBtn) exportBackupBtn.addEventListener('click', exportTrackerBackup);
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
                changeUnit(btn.getAttribute('data-unit'));
                saveState();
                applyThemeAndUnits();
                updateUI();
                refreshWeightSheet();
                const weightTab = document.getElementById('tab-weight');
                if (weightTab && weightTab.classList.contains('active')) renderWeightTab();
                const liftsTab = document.getElementById('tab-lifts');
                if (liftsTab && liftsTab.classList.contains('active')) renderLiftsTab();
            });
        });

        const weightLogButton = document.getElementById('btn-weight-log');
        if (weightLogButton) weightLogButton.addEventListener('click', () => openWeightEntryModal(viewingDateString));
        const scaleInput = document.getElementById('weight-axis-span');
        if (scaleInput) {
            scaleInput.addEventListener('input', () => scaleInput.setCustomValidity(''));
            scaleInput.addEventListener('change', () => {
                if (!scaleInput.value.trim() || !setWeightAxisSpan(Number(scaleInput.value))) {
                    scaleInput.setCustomValidity('Enter a Y range from 0.2 to 6000.');
                    scaleInput.reportValidity();
                }
            });
        }
        const scaleReset = document.getElementById('btn-weight-scale-reset');
        if (scaleReset) scaleReset.addEventListener('click', () => {
            if (scaleInput) scaleInput.setCustomValidity('');
            setWeightAxisSpan(null);
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
        const weightValueInput = document.getElementById('weight-value-input');
        if (weightValueInput) {
            weightValueInput.addEventListener('input', () => {
                weightValueInput.dataset.edited = 'true';
                if (typeof weightValueInput.setCustomValidity === 'function') weightValueInput.setCustomValidity('');
            });
            weightValueInput.addEventListener('change', () => {
                const value = Number(weightValueInput.value);
                if (!Number.isFinite(value) || value < MIN_WEIGHT || value > MAX_WEIGHT) return;
                const index = buildWeightPicker(Math.round(value * 10) / 10);
                pickerScrollEl.scrollTop = index * PICKER_ROW_H;
                pickerScrollEl.setAttribute('aria-valuemin', pickerValues[0]);
                pickerScrollEl.setAttribute('aria-valuemax', pickerValues[pickerValues.length - 1]);
                updateWeightPickerSelection();
            });
        }

        // Update the selected (centered) value as the wheel scrolls. rAF-throttled
        // so a fast flick fires the work once per frame, not per scroll event.
        if (pickerScrollEl) {
            pickerScrollEl.tabIndex = 0;
            pickerScrollEl.setAttribute('role', 'slider');
            pickerScrollEl.setAttribute('aria-label', 'Weight');
            pickerScrollEl.setAttribute('aria-orientation', 'vertical');
            pickerScrollEl.addEventListener('keydown', (event) => {
                const steps = { ArrowDown: 1, ArrowUp: -1, ArrowRight: 1, ArrowLeft: -1 };
                if (!pickerValues.length || (!(event.key in steps) && event.key !== 'Home' && event.key !== 'End')) return;
                event.preventDefault();
                updateWeightPickerSelection();
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? pickerValues.length - 1
                    : Math.max(0, Math.min(pickerValues.length - 1, pickerSelectedIdx + steps[event.key]));
                pickerScrollEl.scrollTop = next * PICKER_ROW_H;
                updateWeightPickerSelection();
            });
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
        let resetDeleteConfirmation = null;
        function closeDotPopup() {
            if (resetDeleteConfirmation) resetDeleteConfirmation();
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
                if (resetDeleteConfirmation) resetDeleteConfirmation();
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
                    const viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
                    if (Number.isFinite(viewportHeight)) top = Math.max(8, Math.min(top, viewportHeight - ph - 8));
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
                    dotDeleteBtn.removeEventListener('click', confirmDelete);
                    cancelBtn.removeEventListener('click', cancelDelete);
                    resetDeleteConfirmation = null;
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
                resetDeleteConfirmation = reset;
                dotDeleteBtn.addEventListener('click', confirmDelete, { once: true });
                cancelBtn.addEventListener('click', cancelDelete, { once: true });
            });
        }

        if (btnSaveWeightEdit) {
            btnSaveWeightEdit.addEventListener('click', () => {
                const dateStr = weightEditModal._editDateStr;
                const typed = weightValueInput && weightValueInput.dataset.edited === 'true';
                if (!typed) updateWeightPickerSelection();
                // The selected value is whichever row the wheel is centered on.
                if (dateStr && (typed || pickerSelectedIdx >= 0)) {
                    const val = typed ? Math.round(Number(weightValueInput.value) * 10) / 10 : pickerValues[pickerSelectedIdx];
                    if (typeof val === 'number' && val >= MIN_WEIGHT && val <= MAX_WEIGHT) {
                        state.weightHistory[dateStr] = val;
                        saveState();
                        refreshWeightSheet();
                        renderWeightTab();
                    } else {
                        if (weightValueInput && typeof weightValueInput.setCustomValidity === 'function') {
                            weightValueInput.setCustomValidity(`Enter a weight between ${MIN_WEIGHT} and ${MAX_WEIGHT}.`);
                            weightValueInput.reportValidity();
                        }
                        return;
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
                closeDotPopup();
            }
        });
    }
});
