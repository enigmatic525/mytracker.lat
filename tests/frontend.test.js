const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual browser logic without adding a browser dependency. The
// instrumentation exists only in this VM: production never exposes its state.
function tracker(saved, options = {}) {
    const elements = new Map();
    const htmlIds = new Set([...fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
        .matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
    const eventTarget = (target) => {
        const listeners = new Map();
        target.addEventListener = (type, callback, settings = {}) => {
            const group = listeners.get(type) ?? [];
            group.push({ callback, once: settings.once });
            listeners.set(type, group);
        };
        target.removeEventListener = (type, callback) => {
            listeners.set(type, (listeners.get(type) ?? []).filter((record) => record.callback !== callback));
        };
        target.dispatch = (type, properties = {}) => {
            const event = { type, target, stopPropagation() {}, preventDefault() {}, ...properties };
            // Browser event dispatch does not run listeners registered midway
            // through the same event; removed listeners must also stay removed.
            for (const record of [...(listeners.get(type) ?? [])]) {
                if (!(listeners.get(type) ?? []).includes(record)) continue;
                if (record.once) target.removeEventListener(type, record.callback);
                record.callback(event);
            }
        };
        return target;
    };
    const makeElement = () => {
        const classes = new Set();
        const attributes = new Map();
        return eventTarget({
            textContent: '', value: '', hidden: false, disabled: false,
            style: { setProperty(name, value) { this[name] = value; } },
            dataset: {}, children: [], scrollLeft: 0, scrollTop: 0, scrollWidth: 0,
            get innerHTML() { return this._innerHTML ?? ''; },
            set innerHTML(value) { this._innerHTML = value; this.children = []; },
            classList: {
                add(...names) { names.forEach((name) => classes.add(name)); },
                remove(...names) { names.forEach((name) => classes.delete(name)); },
                contains(name) { return classes.has(name); },
                toggle(name, force) {
                    const on = force === undefined ? !classes.has(name) : force;
                    if (on) classes.add(name); else classes.delete(name);
                    return on;
                }
            },
            setAttribute(name, value) { attributes.set(name, String(value)); },
            getAttribute(name) { return attributes.get(name) ?? null; },
            appendChild(child) {
                this.children.push(...(child._fragment ? child.children : [child]));
                return child;
            },
            querySelector() { return null; }, querySelectorAll() { return []; },
            contains(child) { return this === child || this.children.some((item) => item.contains(child)); },
            getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
            scrollTo({ top, left }) { if (top !== undefined) this.scrollTop = top; if (left !== undefined) this.scrollLeft = left; },
            setCustomValidity(message) { this.validationMessage = message; },
            reportValidity() { this.validityReported = true; return !this.validationMessage; },
            setPointerCapture(id) { this.capturedPointerId = id; },
            focus() {}, remove() {}
        });
    };
    const document = eventTarget({
        body: makeElement(), documentElement: makeElement(),
        getElementById(id) {
            if (options.fullInit && !htmlIds.has(id)) return null;
            if (!elements.has(id)) elements.set(id, makeElement());
            return elements.get(id);
        },
        querySelector() { return null; }, querySelectorAll() { return []; },
        createElement: makeElement,
        createDocumentFragment() { return Object.assign(makeElement(), { _fragment: true }); }
    });
    const storage = new Map();
    if (saved !== undefined) storage.set('calorieTrackerStateV2', JSON.stringify(saved));
    const animationFrames = new Map();
    let nextFrame = 0;
    const timers = new Map();
    let nextTimer = 0;
    const context = vm.createContext({
        document, navigator: {},
        window: { addEventListener() {}, location: { hostname: 'localhost' }, innerWidth: 500 },
        localStorage: {
            getItem(key) {
                if (options.blockStorage) throw new Error('Storage unavailable');
                return storage.get(key) ?? null;
            },
            setItem(key, value) {
                if (options.blockStorage) throw new Error('Storage unavailable');
                if (options.failMigrationBackup && key.endsWith(':before-fixed-goal')) throw new Error('Storage quota exceeded');
                storage.set(key, value);
            }
        },
        console: { error() {}, warn() {}, log() {} },
        setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        requestAnimationFrame(callback) { const id = ++nextFrame; animationFrames.set(id, callback); return id; },
        cancelAnimationFrame(id) { animationFrames.delete(id); },
        MutationObserver: class { observe() {} disconnect() {} },
        fetch: options.fetch || (async () => { throw new Error('Unexpected network request in frontend test'); }),
        AbortController, Blob, URL
    });
    const source = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
    assert.match(source, /\n    init\(\);/, 'test instrumentation must skip startup');
    const startup = options.fullInit ? source : source.replace(/\n    init\(\);/, '\n    // Startup skipped by the test harness.');
    const instrumented = startup
        .replace(/\n\}\);\s*$/, `
    const originalRenderChart = renderChart;
    const originalRenderWeightTab = renderWeightTab;
    const originalRenderLog = renderLog;
    renderLog = () => {};
    renderChart = () => {};
    renderProgressTab = () => {};
    renderWeightTab = () => {};
    refreshWeightSheet = () => {};
    refreshActiveView = () => updateUI();
    globalThis.trackerTest = {
        loadState, updateUI, dayData, maintenanceFor, addEntry, deleteEntry,
        sanitizeHistoryMap, sanitizeNumberMap, shiftDay, jumpToDate, renderLiftsTab,
        setupWeightChartInteraction, setupEventListeners, openWeightEntryModal,
        estimateRows, addEstimatedEntries, cycleLiftDay, setLiftCycle, setupLiftControls, liftGroupsFor,
        weightAxisBounds, setWeightAxisSpan,
        saveState, handleProgressPhotoSelection,
        setPhotoCompressor: (compressor) => { compressImageToDataUrl = compressor; },
        renderChart: originalRenderChart,
        renderWeightTab: originalRenderWeightTab,
        renderLog: originalRenderLog,
        changeUnit: typeof changeUnit === 'function' ? changeUnit : null,
        getState: () => state,
        setState: (values) => Object.assign(state, values),
        setDates: (today, viewed = today) => { currentDateString = today; viewingDateString = viewed; },
        setSvgPoints: (points) => { currentSvgPts = points; },
        getViewedDate: () => viewingDateString
    };
});`);
    vm.runInContext(instrumented, context, { filename: 'script.js' });
    document.dispatch('DOMContentLoaded');
    const app = context.trackerTest;
    app.setDates('2026-11-10');
    const flushAnimationFrames = () => {
        const callbacks = [...animationFrames.values()];
        animationFrames.clear();
        callbacks.forEach((callback) => callback());
    };
    const flushTimers = (maxDelay = Infinity) => {
        for (const [id, timer] of [...timers]) {
            if (timer.delay <= maxDelay && timers.has(id)) { timers.delete(id); timer.callback(); }
        }
    };
    return { app, elements, storage, document, flushAnimationFrames, flushTimers };
}

test('new tracker uses an absolute 2000 calorie goal', () => {
    const { app, elements } = tracker();
    app.loadState();
    app.updateUI();
    assert.equal(app.getState().goal, 2000);
    assert.equal(elements.get('metric-goal-val').textContent, 2000);
    assert.match(elements.get('calories-left').textContent, /2000/);
});

test('the complete startup runs without script errors using the current HTML element IDs', () => {
    const { app, elements } = tracker(undefined, { fullInit: true });
    assert.equal(app.getState().goal, 2000);
    assert.equal(elements.get('metric-goal-val').textContent, 2000);
    assert.ok(elements.get('chart-bars').children.length >= 7);
    assert.ok(elements.get('weight-sheet').children.length > 40);
});

test('exercise and maintenance do not move the goal or progress denominator', () => {
    const { app, elements } = tracker();
    app.setState({ goal: 2000, maintenance: 3000, history: {
        '2026-11-10': [{ id: 'food', t: 'in', a: 1000 }, { id: 'run', t: 'out', a: 700 }]
    } });
    app.updateUI();
    assert.equal(elements.get('metric-goal-val').textContent, 2000);
    assert.equal(elements.get('progress-bar-fill').style.width, '50%');
    assert.match(elements.get('calories-left').textContent, /1000/);
    assert.equal(elements.get('meter-out-val').textContent, 3700);
});

test('the chart goal line stays at one height when daily exercise changes', () => {
    const { app, elements } = tracker();
    app.setState({ goal: 2000, history: {
        '2026-11-09': [{ id: 'run', t: 'out', a: 700 }],
        '2026-11-10': [{ id: 'food', t: 'in', a: 1000 }]
    } });
    app.renderChart();
    const ticks = elements.get('chart-bars').children.map((column) => column.children[0].children);
    const goals = ticks.flat().filter((item) => item.className === 'chart-goal-tick');
    const burns = ticks.flat().filter((item) => item.className.startsWith('chart-out-tick'));
    assert.equal(goals.length, 7);
    assert.equal(new Set(goals.map((item) => item.style.bottom)).size, 1);
    assert.ok(new Set(burns.map((item) => item.style.bottom)).size > 1);
});

test('going over goal fills the bar without a negative remaining count', () => {
    const { app, elements } = tracker();
    app.setState({ goal: 2000, history: { '2026-11-10': [{ id: 'food', t: 'in', a: 2400 }] } });
    app.updateUI();
    assert.equal(elements.get('progress-bar-fill').style.width, '100%');
    assert.match(elements.get('calories-left').textContent, /400.*over/);
});

test('legacy signed goal migrates using the current dated maintenance baseline', () => {
    const { app } = tracker({ maintenance: 2500, goalBalance: -700,
        maintenanceHistory: { '2026-11-01': 2700, '2026-12-01': 3000 } });
    app.loadState();
    assert.equal(app.getState().goal, 2000);
});

test('an existing absolute goal takes precedence over an obsolete balance', () => {
    const { app } = tracker({ goal: 2100, goalBalance: -700, maintenance: 2500 });
    app.loadState();
    assert.equal(app.getState().goal, 2100);
});

test('unavailable local storage leaves the tracker usable with safe defaults', () => {
    const { app } = tracker(undefined, { blockStorage: true });
    assert.doesNotThrow(() => app.loadState());
    assert.equal(app.getState().goal, 2000);
    assert.equal(app.getState().maintenance, 2500);
});

test('corrupt numeric settings cannot produce negative or non-finite calories', () => {
    const { app } = tracker({ maintenance: -10000, goal: -700 });
    app.loadState();
    assert.ok(app.getState().maintenance >= 500 && app.getState().maintenance <= 9000);
    assert.ok(app.getState().goal >= 500 && app.getState().goal <= 10000);
});

test('invalid weights and impossible calendar dates do not enter weight history', () => {
    const { app } = tracker({ weightHistory: {
        '2026-11-01': 180, '2026-11-02': -1, '2026-11-03': 1501,
        '2026-02-30': 170, 'invalid': 160
    } });
    app.loadState();
    assert.deepEqual(JSON.parse(JSON.stringify(app.getState().weightHistory)), { '2026-11-01': 180 });
});

test('dated maintenance changes preserve earlier days and select the latest breakpoint', () => {
    const { app } = tracker();
    app.setState({ maintenance: 2500, maintenanceHistory: {
        '2026-11-01': 2600, '2026-11-08': 2700
    } });
    assert.equal(app.maintenanceFor('2026-10-31'), 2500);
    assert.equal(app.maintenanceFor('2026-11-01'), 2600);
    assert.equal(app.maintenanceFor('2026-11-07'), 2600);
    assert.equal(app.maintenanceFor('2026-11-10'), 2700);
});

test('lift attendance follows the month and week selected in the header', () => {
    const { app, elements } = tracker();
    app.setDates('2026-11-10', '2026-10-15');
    app.setState({ liftHistory: {
        '2026-10-13': [{ group: 'back' }], '2026-11-09': [{ group: 'chest' }]
    } });
    app.renderLiftsTab();
    assert.equal(elements.get('lift-month-label').textContent, 'October 2026');
    assert.equal(elements.get('lift-week-count').textContent, '1/7');
});

test('delayed AI entries retain the date on which the request started', () => {
    const { app } = tracker();
    const added = app.addEntry('in', 450, 'Lunch', '2026-11-09');
    assert.equal(added, 450);
    assert.equal(app.dayData('2026-11-09').in, 450);
    assert.equal(app.dayData('2026-11-10').in, 0);
});

test('entry cap reports the amount actually added, then rejects further entries', () => {
    const { app } = tracker();
    app.setState({ history: { '2026-11-10': [{ id: 'prior', t: 'in', a: 9900 }] } });
    assert.equal(app.addEntry('in', 450, 'Lunch'), 100);
    assert.equal(app.dayData('2026-11-10').in, 10000);
    assert.equal(app.addEntry('in', 50), 0);
    assert.equal(app.dayData('2026-11-10').in, 10000);
});

test('invalid entry amounts cannot corrupt daily totals', () => {
    const { app } = tracker();
    for (const value of [NaN, Infinity, -50, 0, '500']) assert.equal(app.addEntry('in', value), 0);
    assert.equal(app.dayData('2026-11-10').in, 0);
});

test('unit changes convert all stored weights and retain round-trip precision', () => {
    const { app } = tracker();
    assert.equal(typeof app.changeUnit, 'function');
    app.setState({ unit: 'imperial', weightHistory: { '2026-11-01': 180, '2026-11-02': 179.4 } });
    app.changeUnit('metric');
    assert.equal(app.getState().unit, 'metric');
    assert.ok(Math.abs(app.getState().weightHistory['2026-11-01'] - 180 * 0.45359237) < 1e-9);
    app.changeUnit('imperial');
    assert.ok(Math.abs(app.getState().weightHistory['2026-11-01'] - 180) < 1e-9);
    assert.ok(Math.abs(app.getState().weightHistory['2026-11-02'] - 179.4) < 1e-9);
});

test('calendar navigation moves by dates across daylight-saving changes', () => {
    const { app } = tracker();
    app.setDates('2026-11-10', '2026-11-01');
    app.shiftDay(-1);
    assert.equal(app.getViewedDate(), '2026-10-31');
    app.shiftDay(1);
    assert.equal(app.getViewedDate(), '2026-11-01');
    app.shiftDay(1);
    assert.equal(app.getViewedDate(), '2026-11-02');
});

test('date navigation rejects impossible dates and stops at today', () => {
    const { app } = tracker();
    app.jumpToDate('2026-02-30');
    assert.equal(app.getViewedDate(), '2026-11-10');
    app.jumpToDate('2026-11-09');
    app.shiftDay(2);
    assert.ok(app.getViewedDate() <= '2026-11-10');
});

test('closing weight deletion and selecting a new point cannot delete the prior date', () => {
    const { app, elements, document } = tracker();
    app.setState({ weightHistory: { '2026-11-09': 180, '2026-11-10': 179 } });
    app.setupWeightChartInteraction();
    const overlay = elements.get('weight-chart-overlay');
    const remove = elements.get('weight-dot-delete-btn');
    const choose = (dateStr) => {
        app.setSvgPoints([{ dateStr, date: new Date(`${dateStr}T12:00:00`), weight: 180, x: 50, y: 50 }]);
        overlay.dispatch('click', { clientX: 50, clientY: 200 });
    };
    choose('2026-11-09');
    remove.dispatch('click');
    assert.equal(app.getState().weightHistory['2026-11-09'], 180);
    document.dispatch('click', { target: document.body });
    assert.equal(elements.get('weight-dot-popup').style.display, 'none');
    choose('2026-11-10');
    remove.dispatch('click');
    assert.equal(app.getState().weightHistory['2026-11-09'], 180);
    assert.equal(app.getState().weightHistory['2026-11-10'], 179);
    remove.dispatch('click');
    assert.equal(app.getState().weightHistory['2026-11-09'], 180);
    assert.equal(app.getState().weightHistory['2026-11-10'], undefined);
});

test('switching weight points during deletion requires a fresh confirmation', () => {
    const { app, elements } = tracker();
    app.setState({ weightHistory: { '2026-11-09': 180, '2026-11-10': 179 } });
    app.setupWeightChartInteraction();
    const overlay = elements.get('weight-chart-overlay');
    const remove = elements.get('weight-dot-delete-btn');
    const choose = (dateStr) => {
        app.setSvgPoints([{ dateStr, date: new Date(`${dateStr}T12:00:00`), weight: 180, x: 50, y: 50 }]);
        overlay.dispatch('click', { clientX: 50, clientY: 200 });
    };
    choose('2026-11-09');
    remove.dispatch('click');
    choose('2026-11-10');
    remove.dispatch('click');
    assert.equal(app.getState().weightHistory['2026-11-09'], 180);
    assert.equal(app.getState().weightHistory['2026-11-10'], 179);
});

test('AI form submission keeps its original date during navigation and prevents duplicate requests', async () => {
    let finishFetch;
    const pending = new Promise((resolve) => { finishFetch = resolve; });
    const requests = [];
    const { app, elements } = tracker(undefined, { fetch: (url, request) => {
        requests.push({ url, request });
        return pending;
    } });
    app.setDates('2026-11-10', '2026-11-09');
    app.setState({ weightHistory: { '2026-11-09': 180 } });
    app.setupEventListeners();
    const input = elements.get('ai-food-input');
    input.value = 'One bowl of rice';
    elements.get('ai-food-form').dispatch('submit');
    elements.get('ai-food-form').dispatch('submit');
    assert.equal(requests.length, 1);
    const sent = JSON.parse(requests[0].request.body);
    assert.equal(sent.entry, 'One bowl of rice');
    assert.ok(Math.abs(sent.weightKg - 180 * 0.45359237) < 1e-9);
    app.shiftDay(1);
    finishFetch({ ok: true, json: async () => ({ category: 'food', calories: 450, label: 'Rice', confidence: 'medium' }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.dayData('2026-11-09').in, 450);
    assert.equal(app.dayData('2026-11-10').in, 0);
    assert.equal(elements.get('ai-food-status').hidden, true, 'successful AI entries do not show a receipt');
    assert.equal(input.value, '');
    assert.equal(input.disabled, false);
    assert.equal(elements.get('ai-food-submit').disabled, false);
});

test('AI success reports the actual capped calories rather than the full estimate', async () => {
    const { app, elements } = tracker(undefined, { fetch: async () => ({ ok: true, json: async () => ({
        category: 'food', calories: 450, label: 'Rice', confidence: 'medium'
    }) }) });
    app.setState({ history: { '2026-11-10': [{ id: 'prior', t: 'in', a: 9900 }] } });
    app.setupEventListeners();
    elements.get('ai-food-input').value = 'One bowl of rice';
    elements.get('ai-food-form').dispatch('submit');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.dayData('2026-11-10').in, 10000);
    assert.match(elements.get('ai-food-status').textContent, /\b100\b/);
    assert.doesNotMatch(elements.get('ai-food-status').textContent, /Added[^.]*\b450 calories/);
});

test('zero-calorie AI result gives feedback without logging an entry', async () => {
    const { app, elements } = tracker(undefined, { fetch: async () => ({ ok: true, json: async () => ({
        category: 'food', calories: 0, label: 'Water', confidence: 'high'
    }) }) });
    app.setupEventListeners();
    elements.get('ai-food-input').value = 'A glass of water';
    elements.get('ai-food-form').dispatch('submit');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(Object.keys(app.getState().history).length, 0);
    assert.match(elements.get('ai-food-status').textContent, /\b0\b/);
    assert.equal(elements.get('ai-food-input').value, '');
});

test('failed AI requests retain the description and let the user retry', async () => {
    const { app, elements } = tracker(undefined, { fetch: async () => ({ ok: false, json: async () => ({
        error: 'Please include a food quantity'
    }) }) });
    app.setupEventListeners();
    const input = elements.get('ai-food-input');
    input.value = 'Some rice';
    elements.get('ai-food-form').dispatch('submit');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(input.value, 'Some rice');
    assert.equal(input.disabled, false);
    assert.equal(elements.get('ai-food-submit').disabled, false);
    assert.match(elements.get('ai-food-status').textContent, /Please include a food quantity/);
    assert.ok(elements.get('ai-food-status').classList.contains('error'));
    assert.equal(Object.keys(app.getState().history).length, 0);
});

test('numeric weight entry reaches the full allowed range outside the initial wheel window', () => {
    const { app, elements, flushAnimationFrames } = tracker(undefined, { fullInit: true });
    for (const weight of [1, 250.4, 1500]) {
        app.openWeightEntryModal('2026-11-10');
        flushAnimationFrames();
        const input = elements.get('weight-value-input');
        assert.ok(input, 'the numeric weight control must be present in the actual HTML');
        input.value = String(weight);
        input.dispatch('input');
        input.dispatch('change');
        assert.equal(Number(elements.get('weight-picker-scroll').getAttribute('aria-valuenow')), weight);
        elements.get('btn-save-weight-edit').dispatch('click');
        assert.equal(app.getState().weightHistory['2026-11-10'], weight);
        assert.ok(!elements.get('weight-edit-modal').classList.contains('active'));
    }
});

test('typing a weight and immediately saving does not save the older wheel value', () => {
    const { app, elements, flushAnimationFrames } = tracker();
    app.setupWeightChartInteraction();
    app.openWeightEntryModal('2026-11-10');
    flushAnimationFrames();
    const input = elements.get('weight-value-input');
    input.value = '275.6';
    input.dispatch('input');
    elements.get('btn-save-weight-edit').dispatch('click');
    assert.equal(app.getState().weightHistory['2026-11-10'], 275.6);
});

test('numeric weight changes and wheel keyboard adjustments stay synchronized', () => {
    const { app, elements, flushAnimationFrames } = tracker();
    app.setupWeightChartInteraction();
    app.openWeightEntryModal('2026-11-10');
    flushAnimationFrames();
    const input = elements.get('weight-value-input');
    const wheel = elements.get('weight-picker-scroll');
    input.value = '280.2';
    input.dispatch('input');
    input.dispatch('change');
    wheel.dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(Number(input.value), 280.3);
    elements.get('btn-save-weight-edit').dispatch('click');
    assert.equal(app.getState().weightHistory['2026-11-10'], 280.3);
});

test('invalid numeric weights keep the modal open and preserve the existing entry', () => {
    const { app, elements, flushAnimationFrames } = tracker();
    app.setState({ weightHistory: { '2026-11-10': 180 } });
    app.setupWeightChartInteraction();
    for (const value of ['', '-1', '1501', 'not a number', 'Infinity']) {
        app.openWeightEntryModal('2026-11-10');
        flushAnimationFrames();
        const input = elements.get('weight-value-input');
        input.value = value;
        input.dispatch('input');
        elements.get('btn-save-weight-edit').dispatch('click');
        assert.equal(app.getState().weightHistory['2026-11-10'], 180);
        assert.ok(elements.get('weight-edit-modal').classList.contains('active'));
        assert.ok(input.validationMessage);
        assert.equal(input.validityReported, true);
    }
});

test('failed persistence shows an inline notice and a later successful save clears it', () => {
    const options = { blockStorage: true };
    const { app, elements, storage } = tracker(undefined, options);
    assert.equal(app.saveState(), false);
    const notice = elements.get('tracker-status');
    assert.equal(notice.hidden, false);
    assert.equal(notice.dataset.reason, 'storage');
    assert.ok(notice.textContent.length > 0);
    assert.equal(storage.has('calorieTrackerStateV2'), false);
    options.blockStorage = false;
    assert.equal(app.saveState(), true);
    assert.equal(notice.hidden, true);
    assert.equal(JSON.parse(storage.get('calorieTrackerStateV2')).goal, 2000);
});

test('manual calorie entries report both partial and exhausted daily limits inline', () => {
    const { app, elements } = tracker();
    app.setState({ history: { '2026-11-10': [{ id: 'prior', t: 'in', a: 9900 }] } });
    assert.equal(app.addEntry('in', 450), 100);
    const notice = elements.get('tracker-status');
    assert.equal(notice.dataset.reason, 'entry');
    assert.equal(notice.hidden, false);
    assert.match(notice.textContent, /\b100\b/);
    assert.match(notice.textContent, /\b450\b/);
    const partialMessage = notice.textContent;
    assert.equal(app.addEntry('in', 50), 0);
    assert.equal(app.dayData('2026-11-10').in, 10000);
    assert.notEqual(notice.textContent, partialMessage);
});

test('labeled AI entries leave cap feedback to the AI form instead of duplicating notices', () => {
    const { app, elements } = tracker();
    app.setState({ history: { '2026-11-10': [{ id: 'prior', t: 'in', a: 9900 }] } });
    assert.equal(app.addEntry('in', 450, 'Rice'), 100);
    assert.equal(app.addEntry('in', 50, 'Rice'), 0);
    const notice = elements.get('tracker-status');
    assert.notEqual(notice.dataset.reason, 'entry');
    assert.equal(notice.textContent, '');
});

test('a failed photo does not discard successful images from the same selection', async () => {
    const { app, elements, storage } = tracker();
    const input = elements.get('progress-photo-input');
    const files = [
        { name: 'before.jpg', type: 'image/jpeg' },
        { name: 'broken.jpg', type: 'image/jpeg' },
        { name: 'after.jpg', type: 'image/jpeg' }
    ];
    input.files = files;
    input.value = 'selected';
    app.setPhotoCompressor(async (file) => {
        if (file.name === 'broken.jpg') throw new Error('Image decode failed');
        return `data:image/jpeg;base64,${file.name}`;
    });
    await app.handleProgressPhotoSelection(files);
    const savedPhotos = JSON.parse(storage.get('calorieTrackerStateV2')).progressPhotos['2026-11-10'];
    assert.equal(savedPhotos.length, 2);
    assert.deepEqual(savedPhotos.map((photo) => photo.dataUrl), [
        'data:image/jpeg;base64,before.jpg', 'data:image/jpeg;base64,after.jpg'
    ]);
    assert.equal(input.disabled, false);
    assert.equal(input.value, '');
    const notice = elements.get('tracker-status');
    assert.equal(notice.dataset.reason, 'photos');
    assert.equal(notice.hidden, false);
    assert.match(notice.textContent, /\b2\b/);
    assert.match(notice.textContent, /\b1\b/);
});

test('vertical swipes log food up and exercise down, once per gesture, then reset the wheel', () => {
    const { app, elements } = tracker(undefined, { fullInit: true });
    const selector = elements.get('pending-wheel-scroll');
    const wheel = elements.get('pending-wheel');
    selector.dispatch('keydown', { key: 'ArrowRight' });
    selector.dispatch('keydown', { key: 'ArrowRight' });
    wheel.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    wheel.dispatch('pointermove', { pointerId: 1, clientX: 102, clientY: 60 });
    assert.equal(wheel.capturedPointerId, 1);
    wheel.dispatch('pointerup', { pointerId: 1, clientX: 102, clientY: 50 });
    wheel.dispatch('pointerup', { pointerId: 1, clientX: 102, clientY: 50 });
    assert.equal(app.dayData('2026-11-10').in, 100);
    assert.equal(app.dayData('2026-11-10').out, 0);
    assert.equal(Number(selector.getAttribute('aria-valuenow')), 0);
    let blockedClick = false;
    wheel.dispatch('click', { stopImmediatePropagation() { blockedClick = true; } });
    assert.equal(blockedClick, true, 'release must not reselect the old amount');
    selector.dispatch('keydown', { key: 'ArrowRight' });
    wheel.dispatch('pointerdown', { pointerId: 2, button: 0, clientX: 100, clientY: 100 });
    wheel.dispatch('pointermove', { pointerId: 2, clientX: 100, clientY: 140 });
    wheel.dispatch('pointerup', { pointerId: 2, clientX: 100, clientY: 150 });
    assert.equal(app.dayData('2026-11-10').out, 50);
    assert.equal(Number(selector.getAttribute('aria-valuenow')), 0);
});

test('horizontal drags, short swipes, cancelled pointers and pinches do not log calories', () => {
    const { app, elements } = tracker(undefined, { fullInit: true });
    const selector = elements.get('pending-wheel-scroll');
    const wheel = elements.get('pending-wheel');
    selector.dispatch('keydown', { key: 'ArrowRight' });
    const down = () => wheel.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    down();
    wheel.dispatch('pointermove', { pointerId: 1, clientX: 160, clientY: 105 });
    wheel.dispatch('pointerup', { pointerId: 1, clientX: 160, clientY: 170 });
    down();
    wheel.dispatch('pointermove', { pointerId: 1, clientX: 100, clientY: 120 });
    wheel.dispatch('pointerup', { pointerId: 1, clientX: 100, clientY: 125 });
    down();
    wheel.dispatch('pointercancel', { pointerId: 1 });
    wheel.dispatch('pointerup', { pointerId: 1, clientX: 100, clientY: 150 });
    down();
    wheel.dispatch('pointerdown', { pointerId: 2, isPrimary: false, clientX: 100, clientY: 100 });
    wheel.dispatch('pointerup', { pointerId: 1, clientX: 100, clientY: 150 });
    assert.equal(app.dayData('2026-11-10').in, 0);
    assert.equal(app.dayData('2026-11-10').out, 0);
    assert.equal(Number(selector.getAttribute('aria-valuenow')), 50);
});

test('swipes read the current scroll position before its animation frame and retain the starting date', () => {
    const { app, elements } = tracker(undefined, { fullInit: true });
    const selector = elements.get('pending-wheel-scroll');
    const wheel = elements.get('pending-wheel');
    selector.scrollLeft = 3 * 72;
    selector.dispatch('scroll');
    wheel.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    app.shiftDay(-1);
    wheel.dispatch('pointerup', { pointerId: 1, clientX: 100, clientY: 50 });
    assert.equal(app.dayData('2026-11-10').in, 150);
    assert.equal(app.dayData('2026-11-09').in, 0);
    assert.equal(Number(selector.getAttribute('aria-valuenow')), 0);
});

test('Shift and vertical arrows provide keyboard equivalents of the logging gestures', () => {
    const { app, elements } = tracker(undefined, { fullInit: true });
    const selector = elements.get('pending-wheel-scroll');
    selector.dispatch('keydown', { key: 'ArrowRight' });
    selector.dispatch('keydown', { key: 'ArrowUp', shiftKey: true });
    selector.dispatch('keydown', { key: 'ArrowRight' });
    selector.dispatch('keydown', { key: 'ArrowDown', shiftKey: true });
    selector.dispatch('keydown', { key: 'ArrowDown', shiftKey: true });
    assert.equal(app.dayData('2026-11-10').in, 50);
    assert.equal(app.dayData('2026-11-10').out, 50);
    assert.equal(Number(selector.getAttribute('aria-valuenow')), 0);
});

test('changing dates clears prior-day entry notices and preserves unsaved-data warnings', () => {
    const options = {};
    const { app, elements } = tracker(undefined, options);
    app.setState({ history: { '2026-11-10': [{ id: 'prior', t: 'in', a: 10000 }] } });
    assert.equal(app.addEntry('in', 50), 0);
    const notice = elements.get('tracker-status');
    assert.equal(notice.dataset.reason, 'entry');
    assert.equal(notice.hidden, false);
    app.shiftDay(-1);
    assert.equal(notice.hidden, true);
    options.blockStorage = true;
    assert.equal(app.saveState(), false);
    const warning = notice.textContent;
    app.jumpToDate('2026-11-10');
    assert.equal(notice.hidden, false);
    assert.equal(notice.dataset.reason, 'storage');
    assert.equal(notice.textContent, warning);
});

test('AI multi-food estimates create independently removable rows in source order', async () => {
    const result = { category: 'food', label: 'Breakfast', calories: 451, assumptions: [], breakdown: [
        { label: 'Eggs', calories: 143.4 }, { label: 'Toast', calories: 208.3 }, { label: 'Milk', calories: 99.3 }
    ] };
    const { app, elements } = tracker(undefined, { fullInit: true, fetch: async () => ({ ok: true, json: async () => result }) });
    elements.get('ai-food-input').value = 'Eggs, toast and milk';
    elements.get('ai-food-form').dispatch('submit');
    await new Promise((resolve) => setImmediate(resolve));
    const entries = app.getState().history['2026-11-10'];
    assert.equal(entries.length, 3);
    assert.deepEqual(Array.from(entries).reverse().map((row) => row.label), ['Eggs', 'Toast', 'Milk']);
    assert.equal(app.dayData('2026-11-10').in, 451);
    assert.equal(elements.get('ai-food-status').hidden, true);
    app.deleteEntry(entries.find((row) => row.label === 'Toast').id);
    assert.equal(app.dayData('2026-11-10').in, 243);
    assert.equal(app.getState().history['2026-11-10'].length, 2);
});

test('per-item rounding preserves total calories including fractional values', () => {
    const { app } = tracker();
    const rows = app.estimateRows({ calories: 101, breakdown: [
        { label: 'A', calories: 33.6 }, { label: 'B', calories: 33.6 }, { label: 'C', calories: 33.6 }
    ] }, 'Meal');
    assert.equal(rows.reduce((sum, row) => sum + row.calories, 0), 101);
    assert.deepEqual(Array.from(rows, (row) => row.calories), [34, 34, 33]);
    assert.throws(() => app.estimateRows({ calories: 500, breakdown: [{ label: 'A', calories: 5 }] }, 'Meal'));
});

test('itemized estimates apply the daily cap in the listed order without adding a combined row', () => {
    const { app } = tracker();
    app.setState({ history: { '2026-11-10': [{ id: 'prior', t: 'in', a: 9900 }] } });
    const added = app.addEstimatedEntries({ category: 'food', calories: 300, breakdown: [
        { label: 'Apple', calories: 80 }, { label: 'Sandwich', calories: 220 }
    ] }, 'Lunch', '2026-11-10');
    assert.equal(added, 100);
    const entries = app.getState().history['2026-11-10'];
    assert.equal(entries.find((row) => row.label === 'Apple').a, 80);
    assert.equal(entries.find((row) => row.label === 'Sandwich').a, 20);
    assert.equal(app.dayData('2026-11-10').in, 10000);
});

test('split lift cycles store both groups and clear after the third combination', () => {
    const { app } = tracker();
    app.setLiftCycle('split');
    for (const groups of [['chest', 'back'], ['back', 'leg'], ['leg', 'chest'], []]) {
        app.cycleLiftDay('2026-11-10');
        assert.deepEqual(Array.from(app.liftGroupsFor('2026-11-10')), groups);
    }
    app.setLiftCycle('single');
    for (const groups of [['chest'], ['back'], ['leg'], []]) {
        app.cycleLiftDay('2026-11-10');
        assert.deepEqual(Array.from(app.liftGroupsFor('2026-11-10')), groups);
    }
});

test('changing the lift cycle preserves logged days and survives reload', () => {
    const first = tracker();
    first.app.cycleLiftDay('2026-11-10');
    first.app.setLiftCycle('split');
    assert.deepEqual(Array.from(first.app.liftGroupsFor('2026-11-10')), ['chest']);
    first.app.cycleLiftDay('2026-11-09');
    const saved = JSON.parse(first.storage.get('calorieTrackerStateV2'));
    const next = tracker(saved);
    next.app.loadState();
    assert.equal(next.app.getState().liftCycle, 'split');
    assert.deepEqual(Array.from(next.app.liftGroupsFor('2026-11-09')), ['chest', 'back']);
});

test('holding lifts opens cycle settings and a moved or cancelled pointer does not', () => {
    const { app, elements, flushTimers } = tracker(undefined, { fullInit: true });
    const card = elements.get('lift-attendance-card');
    const modal = elements.get('lift-cycle-modal');
    card.dispatch('pointerdown', { button: 0, clientX: 40, clientY: 40 });
    flushTimers(550);
    assert.ok(modal.classList.contains('active'));
    let stopped = false;
    card.dispatch('click', { stopImmediatePropagation() { stopped = true; } });
    assert.equal(stopped, true, 'the release click must not log a workout');
    elements.get('btn-cancel-lift-cycle').dispatch('click');
    card.dispatch('pointerdown', { button: 0, clientX: 40, clientY: 40 });
    card.dispatch('pointermove', { clientX: 70, clientY: 40 });
    flushTimers(550);
    assert.ok(!modal.classList.contains('active'));
    card.dispatch('pointerdown', { button: 0, clientX: 40, clientY: 40 });
    card.dispatch('pointercancel');
    flushTimers(550);
    assert.ok(!modal.classList.contains('active'));
    assert.equal(Object.keys(app.getState().liftHistory).length, 0);
});

test('the default weight Y range is twice the prior padded range, with an explicit reset', () => {
    const { app, elements } = tracker(undefined, { fullInit: true });
    const automatic = app.weightAxisBounds(170, 180);
    assert.equal(automatic.max - automatic.min, 28); // prior range: 10 + 2*2
    const custom = app.weightAxisBounds(170, 180, 8);
    assert.equal(custom.max - custom.min, 8);
    assert.equal(app.setWeightAxisSpan(8), true);
    assert.equal(app.getState().weightAxisSpan, 8);
    elements.get('btn-weight-scale-reset').dispatch('click');
    assert.equal(app.getState().weightAxisSpan, null);
    assert.equal(app.setWeightAxisSpan(0), false);
    assert.equal(app.setWeightAxisSpan(Infinity), false);
});

test('custom weight scaling persists, converts with units, and updates chart tick extents', () => {
    const { app, elements, storage } = tracker();
    app.setState({ weightHistory: { '2026-11-09': 180, '2026-11-10': 179 } });
    app.setWeightAxisSpan(20);
    app.renderWeightTab();
    const ticks = elements.get('weight-y-axis').children.map((item) => Number(item.textContent));
    assert.equal(ticks[0] - ticks[ticks.length - 1], 20);
    assert.equal(Number(elements.get('weight-axis-span').value), 20);
    app.changeUnit('metric');
    assert.ok(Math.abs(app.getState().weightAxisSpan - 20 * 0.45359237) < 1e-9);
    app.saveState();
    const restored = tracker(JSON.parse(storage.get('calorieTrackerStateV2')));
    restored.app.loadState();
    assert.ok(Math.abs(restored.app.getState().weightAxisSpan - 20 * 0.45359237) < 1e-9);
});


test('existing calorie, weight, photo, lift and preference data survives loading and saving the updated UI', () => {
    const original = {
        goal: 2200, maintenance: 2400, maintenanceHistory: { '2026-10-01': 2600 },
        history: { '2026-11-09': [
            { id: 'old-food', t: 'in', a: 450, label: 'Rice and eggs' },
            { id: 'old-activity', t: 'out', a: 200, label: 'Walk' }
        ] },
        weightHistory: { '2026-11-08': 80.4, '2026-11-09': 80.1 },
        progressPhotos: { '2026-11-09': [{ id: 'photo-1', ts: 1794268800000, dataUrl: 'data:image/jpeg;base64,YWJj' }] },
        liftHistory: { '2026-11-09': [
            { id: 'old-lift-1', group: 'chest', exercise: 'Workout', sets: 1, reps: 1, weight: 0 },
            { id: 'old-lift-2', group: 'back', exercise: 'Workout', sets: 1, reps: 1, weight: 0 }
        ] },
        liftCycle: 'split', weightAxisSpan: 12, theme: 'light', unit: 'metric'
    };
    const { app, storage } = tracker(original, { fullInit: true });
    assert.equal(app.saveState(), true);
    const saved = JSON.parse(storage.get('calorieTrackerStateV2'));
    const contents = (value) => {
        const copy = JSON.parse(JSON.stringify(value));
        for (const key of ['history', 'liftHistory']) {
            Object.values(copy[key]).forEach((rows) => rows.forEach((row) => { delete row.id; }));
        }
        return copy;
    };
    assert.deepEqual(contents(saved), contents(original));
    const reopened = tracker(saved, { fullInit: true });
    assert.equal(reopened.app.dayData('2026-11-09').in, 450);
    assert.equal(reopened.app.dayData('2026-11-09').out, 200);
    assert.equal(reopened.app.getState().progressPhotos['2026-11-09'][0].id, 'photo-1');
    assert.equal(reopened.app.getState().liftCycle, 'split');
});


test('the selected number follows vertical pointer travel and settles without leaving duplicate numbers', () => {
    const { app, elements, flushTimers } = tracker(undefined, { fullInit: true });
    const selector = elements.get('pending-wheel-scroll');
    const wheel = elements.get('pending-wheel');
    const moving = wheel.children.find((item) => item.className === 'hwheel-drag-number');
    selector.dispatch('keydown', { key: 'ArrowRight' });
    selector.dispatch('keydown', { key: 'ArrowRight' });
    wheel.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    wheel.dispatch('pointermove', { pointerId: 1, clientX: 101, clientY: 60 });
    assert.equal(moving.hidden, false);
    assert.equal(moving.textContent, 100);
    assert.equal(moving.style['--swipe-offset'], '-40px');
    assert.equal(selector.children[2].style.visibility, 'hidden');
    wheel.dispatch('pointermove', { pointerId: 1, clientX: 102, clientY: 45 });
    assert.equal(moving.style['--swipe-offset'], '-55px');
    wheel.dispatch('pointerup', { pointerId: 1, clientX: 102, clientY: 45 });
    assert.equal(moving.style['--swipe-offset'], '0px');
    assert.equal(app.dayData('2026-11-10').in, 100);
    assert.equal(selector.children[0].style.visibility, 'hidden');
    flushTimers(180);
    assert.equal(moving.hidden, true);
    assert.equal(selector.children[0].style.visibility, '');
    assert.equal(selector.children[2].style.visibility, '');
    assert.equal(Number(selector.getAttribute('aria-valuenow')), 0);
});

test('cancelled vertical drags restore the selected number; horizontal selection never floats it', () => {
    const { app, elements, flushTimers } = tracker(undefined, { fullInit: true });
    const selector = elements.get('pending-wheel-scroll');
    const wheel = elements.get('pending-wheel');
    const moving = wheel.children.find((item) => item.className === 'hwheel-drag-number');
    selector.dispatch('keydown', { key: 'ArrowRight' });
    wheel.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    wheel.dispatch('pointermove', { pointerId: 1, clientX: 150, clientY: 105 });
    assert.equal(moving.hidden, true);
    wheel.dispatch('pointercancel', { pointerId: 1 });
    wheel.dispatch('pointerdown', { pointerId: 2, button: 0, clientX: 100, clientY: 100 });
    wheel.dispatch('pointermove', { pointerId: 2, clientX: 100, clientY: 120 });
    assert.equal(moving.style['--swipe-offset'], '20px');
    wheel.dispatch('pointercancel', { pointerId: 2 });
    flushTimers(180);
    assert.equal(moving.hidden, true);
    assert.equal(selector.children[1].style.visibility, '');
    assert.equal(Number(selector.getAttribute('aria-valuenow')), 50);
    assert.equal(app.dayData('2026-11-10').in, 0);
    assert.equal(app.dayData('2026-11-10').out, 0);
});

test('upgrading a signed goal backs up the exact original state before saving the new goal', () => {
    const original = { goalBalance: -500, maintenance: 2500,
        history: { '2026-11-09': [{ id: 'food', t: 'in', a: 450, label: 'Lunch' }] },
        weightHistory: { '2026-11-09': 180 } };
    const { app, storage } = tracker(original, { fullInit: true });
    const backupKey = 'calorieTrackerStateV2:before-fixed-goal';
    assert.equal(storage.get(backupKey), JSON.stringify(original));
    const saved = JSON.parse(storage.get('calorieTrackerStateV2'));
    assert.equal(saved.goal, 2000);
    assert.equal(saved.history['2026-11-09'][0].a, 450);
    assert.equal(saved.weightHistory['2026-11-09'], 180);
    app.loadState();
    assert.equal(storage.get(backupKey), JSON.stringify(original));
});

test('an unavailable migration backup leaves the original stored data unchanged on page load', () => {
    const original = { goalBalance: -500, maintenance: 2500,
        history: { '2026-11-09': [{ id: 'food', t: 'in', a: 450, label: 'Lunch' }] } };
    const { app, storage } = tracker(original, { fullInit: true, failMigrationBackup: true });
    assert.equal(app.getState().goal, 2000);
    assert.equal(app.dayData('2026-11-09').in, 450);
    assert.equal(storage.get('calorieTrackerStateV2'), JSON.stringify(original));
});

test('transferring implicit touch capture from a wheel item to its parent does not cancel logging', () => {
    const { app, elements } = tracker(undefined, { fullInit: true });
    const selector = elements.get('pending-wheel-scroll');
    const wheel = elements.get('pending-wheel');
    selector.dispatch('keydown', { key: 'ArrowRight' });
    selector.dispatch('keydown', { key: 'ArrowRight' });
    const item = selector.children[2];
    wheel.dispatch('pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: 100, clientY: 100, target: item });
    wheel.dispatch('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 55, target: item });
    // Safari's implicit item capture is lost when the parent takes explicit capture.
    // This child-targeted event bubbles to the wheel before the next pointer event.
    wheel.dispatch('lostpointercapture', { pointerId: 1, target: item });
    wheel.dispatch('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 45 });
    wheel.dispatch('lostpointercapture', { pointerId: 1, target: wheel });
    assert.equal(app.dayData('2026-11-10').in, 100);
    assert.equal(app.dayData('2026-11-10').out, 0);
    assert.equal(app.getState().history['2026-11-10'].length, 1);
    assert.equal(Number(selector.getAttribute('aria-valuenow')), 0);
});

test('losing the wheel own capture cancels a swipe, while another pointer capture loss does not', () => {
    const { app, elements } = tracker(undefined, { fullInit: true });
    const selector = elements.get('pending-wheel-scroll');
    const wheel = elements.get('pending-wheel');
    selector.dispatch('keydown', { key: 'ArrowRight' });
    wheel.dispatch('pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: 100, clientY: 100 });
    wheel.dispatch('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 50 });
    wheel.dispatch('lostpointercapture', { pointerId: 1, target: wheel });
    wheel.dispatch('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 40 });
    assert.equal(app.dayData('2026-11-10').in, 0);
    assert.equal(Number(selector.getAttribute('aria-valuenow')), 50);
    wheel.dispatch('pointerdown', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 100, clientY: 100 });
    wheel.dispatch('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 100, clientY: 150 });
    wheel.dispatch('lostpointercapture', { pointerId: 999, target: wheel });
    wheel.dispatch('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 100, clientY: 160 });
    assert.equal(app.dayData('2026-11-10').out, 50);
    assert.equal(app.getState().history['2026-11-10'].length, 1);
});
