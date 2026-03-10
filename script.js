document.addEventListener('DOMContentLoaded', () => {
    // State
    const defaultGoal = 2000;
    const defaultMaintenance = 2500;

    let state = {
        goal: defaultGoal,
        maintenance: defaultMaintenance,
        history: {} // format: { 'YYYY-MM-DD': calories }
    };

    let currentDateString = getTodayDateString();
    let viewingDateString = currentDateString;

    let presets = [
        { id: 1, name: 'Apple', calories: 95 },
        { id: 2, name: 'Banana', calories: 105 },
        { id: 3, name: 'Coffee', calories: 5 },
        { id: 4, name: 'Protein Shake', calories: 150 }
    ];

    // DOM Elements
    const dateEl = document.getElementById('current-date');
    const dayLabelEl = document.getElementById('day-label');
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

    // Modals
    const caloriesModal = document.getElementById('calories-modal');
    const caloriesInput = document.getElementById('calories-input');
    const btnCancelCalories = document.getElementById('btn-cancel-calories');
    const btnSaveCalories = document.getElementById('btn-save-calories');

    const goalModal = document.getElementById('goal-modal');
    const goalInput = document.getElementById('goal-input');
    const btnCancelGoal = document.getElementById('btn-cancel-goal');
    const btnSaveGoal = document.getElementById('btn-save-goal');

    const maintModal = document.getElementById('maint-modal');
    const maintInput = document.getElementById('maint-input');
    const btnCancelMaint = document.getElementById('btn-cancel-maint');
    const btnSaveMaint = document.getElementById('btn-save-maint');

    const presetModal = document.getElementById('preset-modal');
    const presetNameInput = document.getElementById('preset-name-input');
    const presetCalInput = document.getElementById('preset-cal-input');
    const btnAddPreset = document.getElementById('btn-add-preset');
    const btnCancelPreset = document.getElementById('btn-cancel-preset');
    const btnSavePreset = document.getElementById('btn-save-preset');

    // Initialization
    init();

    function init() {
        loadState();
        loadPresets();
        updateDateElements();
        updateUI();
        setupEventListeners();
    }

    function getDateString(d) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function getTodayDateString() {
        return getDateString(new Date());
    }

    function loadState() {
        const saved = localStorage.getItem('calorieTrackerStateV2');
        if (saved) {
            state = JSON.parse(saved);
            if (!state.maintenance) state.maintenance = defaultMaintenance;
        } else {
            // Migrate from v1
            const oldSaved = localStorage.getItem('calorieTrackerState');
            if (oldSaved) {
                const old = JSON.parse(oldSaved);
                state.goal = old.goal || defaultGoal;
                if (old.lastUpdated && typeof old.calories === 'number') {
                    state.history[old.lastUpdated] = old.calories;
                }
            }
        }
        // Ensure today is initialized
        if (typeof state.history[currentDateString] !== 'number') {
            state.history[currentDateString] = 0;
        }
    }

    function saveState() {
        localStorage.setItem('calorieTrackerStateV2', JSON.stringify(state));
    }

    function loadPresets() {
        const savedPresets = localStorage.getItem('calorieTrackerPresets');
        if (savedPresets) {
            presets = JSON.parse(savedPresets);
        }
        renderPresets();
    }

    function savePresets() {
        localStorage.setItem('calorieTrackerPresets', JSON.stringify(presets));
        renderPresets();
    }

    function updateDateElements() {
        const d = new Date(viewingDateString + 'T12:00:00');
        const options = { weekday: 'long', month: 'short', day: 'numeric' };
        dateEl.textContent = d.toLocaleDateString('en-US', options);

        if (viewingDateString === currentDateString) {
            dayLabelEl.textContent = 'Today';
            btnNextDay.disabled = true;
        } else {
            const currentD = new Date(currentDateString + 'T12:00:00');
            const diffTime = currentD.getTime() - d.getTime();
            const diffDays = Math.round(diffTime / (1000 * 3600 * 24));

            if (diffDays === 1) {
                dayLabelEl.textContent = 'Yesterday';
            } else {
                dayLabelEl.textContent = `${diffDays} days ago`;
            }
            btnNextDay.disabled = false;
        }
    }

    function updateUI() {
        let cals = state.history[viewingDateString] || 0;
        caloriesCurrentEl.textContent = cals;
        if (metricGoalValEl) metricGoalValEl.textContent = state.goal;
        if (metricMaintValEl) metricMaintValEl.textContent = state.maintenance;

        let diff = state.goal - cals;
        if (diff >= 0) {
            if (caloriesLeftEl) caloriesLeftEl.textContent = `${diff} remaining`;
        } else {
            if (caloriesLeftEl) caloriesLeftEl.textContent = `${Math.abs(diff)} over`;
        }

        // Daily Progress Bar
        let percentage = (cals / state.goal) * 100;
        if (percentage > 100) percentage = 100;
        if (progressBarFill) {
            progressBarFill.style.width = `${percentage}%`;

            if (cals > state.goal) {
                progressBarFill.style.background = 'var(--danger)';
                progressBarFill.style.boxShadow = '0 0 10px rgba(239, 68, 68, 0.3)';
            } else {
                progressBarFill.style.background = 'var(--accent-primary)';
                progressBarFill.style.boxShadow = '0 0 10px rgba(139, 92, 246, 0.3)';
            }
        }

        renderChart();
    }

    function renderChart() {
        chartBarsEl.innerHTML = '';
        if (chartLabelsRowEl) chartLabelsRowEl.innerHTML = '';

        const daysToShow = 7;
        const historyData = [];
        let weeklyDiff = 0;

        // Show 7 days ending on the viewing date
        let viewD = new Date(viewingDateString + 'T12:00:00');
        let maxCals = Math.max(state.goal, state.maintenance);

        for (let i = daysToShow - 1; i >= 0; i--) {
            let tempD = new Date(viewD.getTime() - i * 24 * 60 * 60 * 1000);
            let dStr = getDateString(tempD);
            let c = state.history[dStr] || 0;
            if (c > maxCals) maxCals = c;

            weeklyDiff += (c - state.maintenance);

            historyData.push({
                dateStr: dStr,
                cals: c,
                label: tempD.toLocaleDateString('en-US', { weekday: 'narrow' })
            });
        }

        if (weeklyDiffLabelEl) {
            const sign = weeklyDiff > 0 ? '+' : '';
            weeklyDiffLabelEl.textContent = `This week: ${sign}${weeklyDiff}`;
        }

        // Give 20% headroom
        const chartMax = maxCals * 1.2;

        // Goal line percentage
        const goalPercent = Math.min((state.goal / chartMax) * 100, 100);
        chartGoalLineEl.style.bottom = `${goalPercent}%`;
        chartGoalLineEl.style.top = 'auto';

        // Maintenance line percentage
        const maintPercent = Math.min((state.maintenance / chartMax) * 100, 100);
        if (chartMaintenanceLineEl) {
            chartMaintenanceLineEl.style.bottom = `${maintPercent}%`;
            chartMaintenanceLineEl.style.top = 'auto';
        }

        historyData.forEach(item => {
            const isViewingDay = item.dateStr === viewingDateString;
            const heightPercent = Math.min((item.cals / chartMax) * 100, 100);

            const col = document.createElement('div');
            col.className = `chart-col ${isViewingDay ? 'active' : ''}`;

            const barWrapper = document.createElement('div');
            barWrapper.className = 'chart-bar-wrapper';

            const bar = document.createElement('div');
            let barClasses = 'chart-bar';
            if (isViewingDay) barClasses += ' active';
            bar.className = barClasses;
            bar.style.height = `${Math.max(heightPercent, 2)}%`;

            // +/- inside bar text has been removed
            const diffFromMaint = item.cals - state.maintenance;
            const sign = diffFromMaint > 0 ? '+' : '';
            const diffText = diffFromMaint === 0 ? '0' : `${sign}${diffFromMaint}`;

            const diffEl = document.createElement('div');
            diffEl.className = 'bar-diff-text';
            diffEl.textContent = diffText;

            barWrapper.appendChild(diffEl);
            barWrapper.appendChild(bar);
            col.appendChild(barWrapper);
            chartBarsEl.appendChild(col);

            if (chartLabelsRowEl) {
                const labelEl = document.createElement('div');
                labelEl.className = 'chart-label';
                if (isViewingDay) {
                    labelEl.style.color = 'var(--text-primary)';
                    labelEl.style.fontWeight = '600';
                }
                labelEl.textContent = item.label;
                chartLabelsRowEl.appendChild(labelEl);
            }
        });
    }

    function adjustCalories(amount) {
        let current = state.history[viewingDateString] || 0;
        current += amount;
        if (current < 0) current = 0;

        state.history[viewingDateString] = current;

        caloriesCurrentEl.style.transform = 'scale(1.1)';
        setTimeout(() => {
            caloriesCurrentEl.style.transform = 'scale(1)';
        }, 150);

        saveState();
        updateUI();
    }

    function renderPresets() {
        presetsGrid.innerHTML = '';
        presets.forEach(preset => {
            const el = document.createElement('div');
            el.className = 'preset-card';
            el.innerHTML = `
                <div class="preset-info">
                    <div class="preset-name">${preset.name}</div>
                    <div class="preset-cal">${preset.calories > 0 ? '+' : ''}${preset.calories}</div>
                </div>
                <button class="preset-delete" data-id="${preset.id}" aria-label="Delete preset">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
            `;

            el.addEventListener('click', (e) => {
                if (e.target.closest('.preset-delete')) return;
                adjustCalories(preset.calories);
            });

            const deleteBtn = el.querySelector('.preset-delete');
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                presets = presets.filter(p => p.id !== preset.id);
                savePresets();
            });

            presetsGrid.appendChild(el);
        });
    }

    function setupEventListeners() {
        // Day Navigation
        btnPrevDay.addEventListener('click', () => {
            const d = new Date(viewingDateString + 'T12:00:00');
            d.setDate(d.getDate() - 1);
            viewingDateString = getDateString(d);

            // Ensure day exists in history
            if (typeof state.history[viewingDateString] !== 'number') {
                state.history[viewingDateString] = 0;
            }

            updateDateElements();
            updateUI();
        });

        btnNextDay.addEventListener('click', () => {
            if (btnNextDay.disabled) return;
            const d = new Date(viewingDateString + 'T12:00:00');
            d.setDate(d.getDate() + 1);
            viewingDateString = getDateString(d);

            // Ensure day exists in history
            if (typeof state.history[viewingDateString] !== 'number') {
                state.history[viewingDateString] = 0;
            }

            updateDateElements();
            updateUI();
        });

        // Quick Actions
        btnMinus100.addEventListener('click', () => adjustCalories(-100));
        btnMinus50.addEventListener('click', () => adjustCalories(-50));
        btnPlus50.addEventListener('click', () => adjustCalories(50));
        btnPlus100.addEventListener('click', () => adjustCalories(100));

        // Calories Modal
        caloriesCurrentEl.addEventListener('click', () => {
            caloriesInput.value = state.history[viewingDateString] || 0;
            caloriesModal.classList.add('active');
            setTimeout(() => caloriesInput.focus(), 100);
        });

        btnCancelCalories.addEventListener('click', () => {
            caloriesModal.classList.remove('active');
        });

        btnSaveCalories.addEventListener('click', () => {
            const newCals = parseInt(caloriesInput.value);
            if (!isNaN(newCals) && newCals >= 0) {
                state.history[viewingDateString] = newCals;
                saveState();
                updateUI();
            }
            caloriesModal.classList.remove('active');
        });

        // Goal Modal
        if (metricGoalEl) {
            metricGoalEl.addEventListener('click', () => {
                goalInput.value = state.goal;
                goalModal.classList.add('active');
                setTimeout(() => goalInput.focus(), 100);
            });
        }

        btnCancelGoal.addEventListener('click', () => {
            goalModal.classList.remove('active');
        });

        btnSaveGoal.addEventListener('click', () => {
            const newGoal = parseInt(goalInput.value);
            if (!isNaN(newGoal) && newGoal > 0) {
                state.goal = newGoal;
                saveState();
                updateUI();
            }
            goalModal.classList.remove('active');
        });

        // Maintenance Modal
        if (metricMaintEl) {
            metricMaintEl.addEventListener('click', () => {
                maintInput.value = state.maintenance;
                maintModal.classList.add('active');
                setTimeout(() => maintInput.focus(), 100);
            });
        }

        btnCancelMaint.addEventListener('click', () => {
            maintModal.classList.remove('active');
        });

        btnSaveMaint.addEventListener('click', () => {
            const newMaint = parseInt(maintInput.value);
            if (!isNaN(newMaint) && newMaint > 0) {
                state.maintenance = newMaint;
                saveState();
                updateUI();
            }
            maintModal.classList.remove('active');
        });

        // Preset Modal
        btnAddPreset.addEventListener('click', () => {
            presetNameInput.value = '';
            presetCalInput.value = '';
            presetModal.classList.add('active');
            setTimeout(() => presetNameInput.focus(), 100);
        });

        btnCancelPreset.addEventListener('click', () => {
            presetModal.classList.remove('active');
        });

        btnSavePreset.addEventListener('click', () => {
            const name = presetNameInput.value.trim();
            const cal = parseInt(presetCalInput.value);
            if (name && !isNaN(cal) && cal !== 0) {
                presets.push({
                    id: Date.now(),
                    name: name,
                    calories: cal
                });
                savePresets();
            }
            presetModal.classList.remove('active');
        });

        // Close modals on overlay click
        [caloriesModal, goalModal, maintModal, presetModal].forEach(modal => {
            if (modal) {
                modal.addEventListener('click', (e) => {
                    if (e.target === modal) {
                        modal.classList.remove('active');
                    }
                });
            }
        });

        caloriesCurrentEl.style.transition = 'transform 0.15s ease-out';
    }
});
