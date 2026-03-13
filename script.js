document.addEventListener('DOMContentLoaded', () => {
    // State
    const defaultGoal = 2000;
    const defaultMaintenance = 2500;

    let state = {
        goal: defaultGoal,
        maintenance: defaultMaintenance,
        history: {}, // format: { 'YYYY-MM-DD': calories }
        weightHistory: {},
        lifts: [
            { id: 1, name: 'Bench', group: 'push' },
            { id: 2, name: 'Incline Smith', group: 'push' },
            { id: 3, name: 'Cable Pushdown', group: 'push' },
            { id: 4, name: 'Lateral Raise', group: 'push' },
            { id: 5, name: 'Pull Ups', group: 'pull' },
            { id: 6, name: 'Low Row', group: 'pull' },
            { id: 7, name: 'Dumbbell Curl', group: 'pull' },
            { id: 8, name: 'Squat', group: 'legs' },
            { id: 9, name: 'Deadlift', group: 'legs' }
        ],
        liftSets: {} 
    };

    let currentDateString = getTodayDateString();
    let viewingDateString = currentDateString;

    let presets = [
        { id: 1, name: 'Hamburger', calories: 350 },
        { id: 2, name: 'Medium Fries', calories: 400 },
        { id: 3, name: 'Chips', calories: 200 },
        { id: 4, name: 'Boba Tea', calories: 500 }
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

        // Tutorial overlay
        const tutorialOverlay = document.getElementById('tutorial-overlay');
        const btnTutorialClose = document.getElementById('btn-tutorial-close');
        if (tutorialOverlay && btnTutorialClose) {
            const seen = localStorage.getItem('trackerTutorialSeen');
            if (!seen) {
                tutorialOverlay.classList.remove('hidden');
            } else {
                tutorialOverlay.classList.add('hidden');
            }
            btnTutorialClose.addEventListener('click', () => {
                tutorialOverlay.classList.add('hidden');
                localStorage.setItem('trackerTutorialSeen', '1');
            });
        }
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
            if (!state.weightHistory) state.weightHistory = {};
            if (!state.lifts) state.lifts = [
                { id: 1, name: 'Bench', group: 'push' },
                { id: 2, name: 'Incline Smith', group: 'push' },
                { id: 3, name: 'Cable Pushdown', group: 'push' },
                { id: 4, name: 'Lateral Raise', group: 'push' },
                { id: 5, name: 'Pull Ups', group: 'pull' },
                { id: 6, name: 'Low Row', group: 'pull' },
                { id: 7, name: 'Dumbbell Curl', group: 'pull' },
                { id: 8, name: 'Squat', group: 'legs' },
                { id: 9, name: 'Deadlift', group: 'legs' }
            ];
            if (!state.liftSets) state.liftSets = {};
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

        // Only count days that actually have an entry
            if (c > 0) {
                weeklyDiff += (c - state.maintenance);
            }

            // Push null for days with no entry (they'll render as empty columns)
            historyData.push({
                dateStr: dStr,
                cals: c,
                hasEntry: c > 0,
                label: tempD.toLocaleDateString('en-US', { weekday: 'narrow' })
            });
        }

        if (weeklyDiffLabelEl) {
            const calSign = weeklyDiff > 0 ? '+' : '';
            const lbs = (weeklyDiff / 3500).toFixed(1);
            const lbSign = weeklyDiff > 0 ? '+' : '';
            weeklyDiffLabelEl.textContent = `This Week: ${calSign}${weeklyDiff} cal, ${lbSign}${lbs} lbs`;
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
            // Only render a bar if the day has actual data
            const heightPercent = item.hasEntry
                ? Math.min((item.cals / chartMax) * 100, 100)
                : 0;

            const col = document.createElement('div');
            col.className = `chart-col ${isViewingDay ? 'active' : ''}`;

            const barWrapper = document.createElement('div');
            barWrapper.className = 'chart-bar-wrapper';

            const bar = document.createElement('div');
            let barClasses = 'chart-bar';
            if (isViewingDay) barClasses += ' active';
            bar.className = barClasses;
            // If no entry leave bar invisible (don't show 2% stub)
            bar.style.height = item.hasEntry ? `${Math.max(heightPercent, 2)}%` : '0%';

            const diffEl = document.createElement('div');
            diffEl.className = 'bar-diff-text';
            if (item.hasEntry) {
                const diffFromMaint = item.cals - state.maintenance;
                const sign = diffFromMaint > 0 ? '+' : '';
                diffEl.textContent = diffFromMaint === 0 ? '0' : `${sign}${diffFromMaint}`;
            }

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

        // Goal Modal — stepper
        const goalDisplay = document.getElementById('goal-display');
        const goalModalNote = document.getElementById('goal-modal-note');
        let goalVal = state.goal;

        function updateGoalModal() {
            goalDisplay.textContent = goalVal;
            const diff = goalVal - state.maintenance;
            const lbsPerWeek = (diff * 7 / 3500).toFixed(1);
            const dir = diff > 0 ? 'gain' : diff < 0 ? 'lose' : 'maintain';
            const absLbs = Math.abs(lbsPerWeek);
            if (dir === 'maintain') {
                goalModalNote.textContent = 'Based on your TDEE, you are set to maintain your weight.';
            } else {
                goalModalNote.textContent = `Based on your TDEE, you can expect to ${dir} ${absLbs} pounds per week.`;
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

        btnCancelGoal.addEventListener('click', () => {
            goalModal.classList.remove('active');
        });

        btnSaveGoal.addEventListener('click', () => {
            state.goal = goalVal;
            saveState();
            updateUI();
            goalModal.classList.remove('active');
        });

        // TDEE Modal — stepper
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

        btnCancelMaint.addEventListener('click', () => {
            maintModal.classList.remove('active');
        });

        btnSaveMaint.addEventListener('click', () => {
            state.maintenance = maintVal;
            saveState();
            updateUI();
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
            if (presets.length >= 4) {
                alert('Maximum of 4 presets allowed.');
                return;
            }
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
        
        setupTabsAndNewFeatures();
    }

    // --- NEW FEATURES ---
    function setupTabsAndNewFeatures() {
        const navTabs = document.querySelectorAll('.nav-tab');
        const tabPanes = document.querySelectorAll('.tab-pane');

        navTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                navTabs.forEach(t => t.classList.remove('active'));
                tabPanes.forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.getAttribute('data-target')).classList.add('active');
                if (tab.getAttribute('data-target') === 'tab-weight') {
                    renderWeightTab();
                } else if (tab.getAttribute('data-target') === 'tab-lifts') {
                    renderLiftsTab();
                }
            });
        });

        // ------ WEIGHT TAB LOGIC
        const weightInput = document.getElementById('weight-input');
        const btnWeightMinus = document.getElementById('btn-weight-minus');
        const btnWeightPlus = document.getElementById('btn-weight-plus');
        const btnSaveWeight = document.getElementById('btn-save-weight');
        const weightChartToggles = document.querySelectorAll('#weight-chart-toggles .chart-toggle');
        let currentWeightRange = 'month';

        weightChartToggles.forEach(t => {
            t.addEventListener('click', () => {
                weightChartToggles.forEach(btn => btn.classList.remove('active'));
                t.classList.add('active');
                currentWeightRange = t.getAttribute('data-range');
                renderWeightTab();
            });
        });

        btnWeightMinus.addEventListener('click', () => {
            let num = parseFloat(weightInput.value);
            if(isNaN(num)) num = 0;
            weightInput.value = (num - 0.1).toFixed(1);
        });
        
        btnWeightPlus.addEventListener('click', () => {
            let num = parseFloat(weightInput.value);
            if(isNaN(num)) num = 0;
            weightInput.value = (num + 0.1).toFixed(1);
        });
        
        btnSaveWeight.addEventListener('click', () => {
            const val = parseFloat(weightInput.value);
            if (!isNaN(val) && val > 0) {
                state.weightHistory[viewingDateString] = val;
                saveState();
                renderWeightTab();
                const orig = btnSaveWeight.textContent;
                btnSaveWeight.textContent = 'Saved!';
                setTimeout(() => btnSaveWeight.textContent = orig, 1500);
            }
        });

        function renderWeightTab() {
            // Update input to viewing/today's logged weight
            const wKeys = Object.keys(state.weightHistory).sort();
            let lastW = wKeys.length > 0 ? state.weightHistory[wKeys[wKeys.length - 1]] : 150.0;
            weightInput.value = state.weightHistory[viewingDateString] 
                             || state.weightHistory[getTodayDateString()] 
                             || lastW;

            const svgEl = document.getElementById('weight-chart-svg');
            const emptyEl = document.getElementById('weight-chart-empty');
            if (!svgEl) return;

            // Clear previous path content but keep the path element
            const pathLine = document.getElementById('weight-chart-line');

            const daysMap = { 'week': 7, 'month': 30, 'year': 365 };
            const days = daysMap[currentWeightRange] || 30;

            // Collect data points in order
            let dataPoints = [];
            let viewD = new Date(viewingDateString + 'T12:00:00');
            for (let i = days - 1; i >= 0; i--) {
                let tempD = new Date(viewD.getTime() - i * 24 * 60 * 60 * 1000);
                let dStr = getDateString(tempD);
                let w = state.weightHistory[dStr];
                if (w) {
                    dataPoints.push({ slotIndex: days - 1 - i, y: w });
                }
            }

            if (dataPoints.length < 2) {
                pathLine.setAttribute('d', '');
                if (emptyEl) emptyEl.style.display = 'flex';
                return;
            }

            if (emptyEl) emptyEl.style.display = 'none';

            // Find y range with some padding
            let maxW = Math.max(...dataPoints.map(p => p.y));
            let minW = Math.min(...dataPoints.map(p => p.y));
            const yPad = Math.max((maxW - minW) * 0.15, 0.5);
            maxW += yPad;
            minW -= yPad;
            const yRange = maxW - minW;

            // viewBox: 0 0 (days-1) 100 — x mapped 0..days-1, y mapped 0..100 (0=top)
            svgEl.setAttribute('viewBox', `0 0 ${days - 1} 100`);

            let dPath = '';
            dataPoints.forEach((pt, index) => {
                const px = pt.slotIndex;
                const py = 100 - ((pt.y - minW) / yRange) * 100;
                dPath += (index === 0 ? 'M' : 'L') + `${px.toFixed(2)},${py.toFixed(2)} `;
            });

            pathLine.setAttribute('d', dPath.trim());
        }


        // ------ LIFTS TAB LOGIC
        const pplToggles = document.querySelectorAll('.ppl-toggle');
        const liftsList = document.getElementById('lifts-list');
        const liftsMainView = document.getElementById('lifts-main-view');
        const liftDetailView = document.getElementById('lift-detail-view');
        const btnBackLifts = document.getElementById('btn-back-lifts');
        const liftDetailTitle = document.getElementById('lift-detail-title');
        
        let currentPPL = 'push';
        let currentLiftId = null;

        pplToggles.forEach(t => {
            t.addEventListener('click', () => {
                pplToggles.forEach(btn => btn.classList.remove('active', 'btn-primary'));
                t.classList.add('active', 'btn-primary');
                currentPPL = t.getAttribute('data-ppl');
                renderLiftsTab();
            });
        });

        btnBackLifts.addEventListener('click', () => {
            liftDetailView.style.display = 'none';
            liftsMainView.style.display = 'block';
            currentLiftId = null;
        });

        function renderLiftsTab() {
            liftsList.innerHTML = '';
            const filteredLifts = state.lifts.filter(l => l.group === currentPPL);
            filteredLifts.forEach(lift => {
                const el = document.createElement('div');
                el.className = 'lift-item';
                
                let last1RM = '--';
                if(state.liftSets[lift.id] && state.liftSets[lift.id].length > 0) {
                    last1RM = state.liftSets[lift.id][state.liftSets[lift.id].length - 1].est1RM + ' lbs';
                }
                el.innerHTML = `
                    <div>
                        <div class="lift-name">${lift.name}</div>
                        <div class="lift-meta">Est. 1RM: ${last1RM}</div>
                    </div>
                `;
                el.addEventListener('click', () => openLiftDetail(lift));
                liftsList.appendChild(el);
            });
        }

        function openLiftDetail(lift) {
            currentLiftId = lift.id;
            liftDetailTitle.textContent = lift.name;
            liftsMainView.style.display = 'none';
            liftDetailView.style.display = 'flex';
            renderLiftDetail();
        }

        const btnSaveLiftSet = document.getElementById('btn-save-lift-set');
        const liftWeightInput = document.getElementById('lift-weight-input');
        const liftRepsInput = document.getElementById('lift-reps-input');
        const liftHistoryList = document.getElementById('lift-history-list');

        btnSaveLiftSet.addEventListener('click', () => {
            const w = parseFloat(liftWeightInput.value);
            const r = parseInt(liftRepsInput.value);
            if (!isNaN(w) && w > 0 && !isNaN(r) && r > 0 && currentLiftId) {
                const est1RM = Math.round(w * (1 + r / 30));
                if (!state.liftSets[currentLiftId]) state.liftSets[currentLiftId] = [];
                state.liftSets[currentLiftId].push({
                    id: Date.now(),
                    date: viewingDateString,
                    weight: w,
                    reps: r,
                    est1RM: est1RM
                });
                saveState();
                renderLiftDetail();
                liftWeightInput.value = '';
                liftRepsInput.value = '';
            }
        });

        document.getElementById('btn-delete-lift').addEventListener('click', () => {
            if (confirm('Delete this exercise and all its history?')) {
                state.lifts = state.lifts.filter(l => l.id !== currentLiftId);
                delete state.liftSets[currentLiftId];
                saveState();
                btnBackLifts.click();
                renderLiftsTab();
            }
        });

        function renderLiftDetail() {
            liftHistoryList.innerHTML = '';
            const sets = state.liftSets[currentLiftId] || [];
            
            const todaySets = sets.filter(s => s.date === viewingDateString);
            if (todaySets.length === 0) {
                liftHistoryList.innerHTML = '<div style="font-size: 13px; color: var(--text-secondary);">No sets recorded today.</div>';
            } else {
                todaySets.forEach(set => {
                    const el = document.createElement('div');
                    el.className = 'set-item';
                    el.innerHTML = `
                        <div class="set-meta">
                            <span>${set.weight} lbs × ${set.reps}</span>
                        </div>
                        <div style="display: flex; gap: 12px; align-items: center;">
                            <span class="set-1rm">${set.est1RM} 1RM</span>
                            <button class="btn-delete-set" data-id="${set.id}">×</button>
                        </div>
                    `;
                    el.querySelector('.btn-delete-set').addEventListener('click', () => {
                        state.liftSets[currentLiftId] = state.liftSets[currentLiftId].filter(s => s.id !== set.id);
                        saveState();
                        renderLiftDetail();
                    });
                    liftHistoryList.appendChild(el);
                });
            }

            const svgGroup = document.getElementById('lift-chart-svg');
            const pathLine = document.getElementById('lift-chart-line');
            if(!svgGroup || !pathLine) return;

            const texts = svgGroup.querySelectorAll('text');
            texts.forEach(t => t.remove());

            if (sets.length < 2) {
                pathLine.setAttribute('d', '');
                svgGroup.innerHTML += '<text x="50%" y="50%" fill="var(--text-secondary)" font-size="12" text-anchor="middle" dominant-baseline="middle">Add sets to see 1RM progression</text>';
                return;
            }

            let max1RM = 0, min1RM = 9999;
            sets.forEach(s => {
                if (s.est1RM > max1RM) max1RM = s.est1RM;
                if (s.est1RM < min1RM) min1RM = s.est1RM;
            });

            const rangeR = max1RM - min1RM || 1;
            svgGroup.setAttribute('viewBox', `0 0 ${sets.length - 1} 100`);
            
            let dPath = '';
            sets.forEach((set, index) => {
                const px = index;
                const py = 100 - ((set.est1RM - min1RM) / rangeR) * 80 - 10;
                dPath += (index === 0 ? 'M' : 'L') + `${px},${py} `;
            });
            pathLine.setAttribute('d', dPath.trim());
            if(!svgGroup.querySelector('path')) {
                svgGroup.appendChild(pathLine);
            }
        }

        // Add Lift Modal
        const liftModal = document.getElementById('lift-modal');
        const liftNameInput = document.getElementById('lift-name-input');
        const liftGroupInput = document.getElementById('lift-group-input');
        
        document.getElementById('btn-add-lift').addEventListener('click', () => {
            liftNameInput.value = '';
            liftGroupInput.value = currentPPL;
            liftModal.classList.add('active');
        });

        document.getElementById('btn-cancel-lift').addEventListener('click', () => {
            liftModal.classList.remove('active');
        });

        document.getElementById('btn-save-lift').addEventListener('click', () => {
            const name = liftNameInput.value.trim();
            const grp = liftGroupInput.value;
            if (name) {
                state.lifts.push({
                    id: Date.now(),
                    name: name,
                    group: grp
                });
                saveState();
                renderLiftsTab();
            }
            liftModal.classList.remove('active');
        });

        if (liftModal) {
            liftModal.addEventListener('click', (e) => {
                if (e.target === liftModal) liftModal.classList.remove('active');
            });
        }
        
        // Initial tab render
        renderLiftsTab();
    }
});
