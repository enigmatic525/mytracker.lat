const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// All provider calls are mocked: these verify arithmetic, request/response
// boundaries and failures, not the model's real-world nutrition accuracy.
const originalKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = 'test-key-not-a-real-secret';
const handler = require('../api/food');
const originalFetch = global.fetch;
const originalModel = process.env.OPENAI_CALORIE_MODEL;

function estimate(overrides = {}) {
    return {
        category: 'food', label: 'Two servings of yogurt', confidence: 'high',
        assumptions: [], clarification: null,
        items: [{ label: 'Yogurt', quantity: 2, unit: 'serving', calories_per_unit: 150 }],
        activities: [], ...overrides
    };
}

function provider(estimateValue, overrides = {}) {
    return {
        ok: true, status: 200,
        json: async () => ({
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(estimateValue) }] }],
            ...overrides
        })
    };
}

async function request(body = { entry: 'Two servings yogurt, 150 calories per serving' }, overrides = {}) {
    const res = {
        headers: {}, statusCode: 200,
        setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; },
        end() { return this; }
    };
    await handler({ method: 'POST', headers: {}, body, ...overrides }, res);
    return res;
}

beforeEach((t) => {
    process.env.OPENAI_API_KEY = 'test-key-not-a-real-secret';
    delete process.env.OPENAI_CALORIE_MODEL;
    global.fetch = async () => provider(estimate());
    t.mock.method(console, 'error', () => {});
});

afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.OPENAI_CALORIE_MODEL;
    else process.env.OPENAI_CALORIE_MODEL = originalModel;
});

test('multiplies explicit serving quantities and preserves the response contract', async () => {
    const result = await request();
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.category, 'food');
    assert.equal(result.body.calories, 300);
    assert.equal(result.body.confidence, 'high');
    assert.deepEqual(result.body.assumptions, []);
    assert.deepEqual(result.body.breakdown, [{ label: 'Yogurt', quantity: 2, unit: 'serving', calories: 300 }]);
    assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('scales grams and fractions, sums all ingredients and rounds only the final total', async () => {
    global.fetch = async () => provider(estimate({ items: [
        { label: 'Cooked chicken', quantity: 200, unit: 'g', calories_per_unit: 1.65 },
        { label: 'Half pizza', quantity: 0.5, unit: 'pizza', calories_per_unit: 601 },
        { label: 'Sauce', quantity: 0.5, unit: 'tsp', calories_per_unit: 1 }
    ] }));
    const result = await request({ entry: '200 g cooked chicken and half a 601 kcal pizza with half a tsp sauce' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.calories, 631);
    assert.equal(result.body.breakdown.length, 3);
});

test('accepts actual zero-calorie items instead of inventing one calorie', async () => {
    global.fetch = async () => provider(estimate({ label: 'Water', items: [
        { label: 'Water', quantity: 500, unit: 'ml', calories_per_unit: 0 }
    ] }));
    const result = await request({ entry: '500 ml water' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.calories, 0);
});

test('computes net exercise calories above rest because the app already counts resting burn', async () => {
    global.fetch = async () => provider(estimate({
        category: 'exercise', label: '30 minute run', confidence: 'medium', items: [],
        activities: [{ label: 'Running', minutes: 30, met: 8, weight_kg: 70 }]
    }));
    const result = await request({ entry: '30 minute run at 70 kg', weightKg: 90 });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.calories, 257); // (8 - 1) * 3.5 * 70 / 200 * 30 = 257.25
    assert.notEqual(result.body.calories, 294); // Gross MET total would count rest again.
    assert.ok(result.body.assumptions.some((item) => item.includes('above rest')));
});

test('does not subtract resting metabolism from an explicitly reported watch reading', async () => {
    global.fetch = async () => provider(estimate({ category: 'exercise', label: 'Run: watch reading', items: [
        { label: 'Watch calories', quantity: 1, unit: 'workout', calories_per_unit: 350 }
    ] }));
    const result = await request({ entry: 'My watch says I burned 350 active calories running' });
    assert.equal(result.body.calories, 350);
});

test('keeps uncertain portions visible and prevents high confidence with assumptions', async () => {
    global.fetch = async () => provider(estimate({ assumptions: ['Assumed one 200 g bowl.'] }));
    const result = await request();
    assert.equal(result.body.confidence, 'medium');
    assert.deepEqual(result.body.assumptions, ['Assumed one 200 g bowl.']);
});

test('returns actionable clarification without logging an unrelated or ambiguous entry', async () => {
    global.fetch = async () => provider(estimate({
        category: 'unknown', label: '', items: [], confidence: 'low',
        clarification: 'How many minutes did you cycle?'
    }));
    const result = await request({ entry: 'I cycled' });
    assert.equal(result.statusCode, 422);
    assert.equal(result.body.error, 'How many minutes did you cycle?');
    assert.equal(result.body.calories, undefined);
});

test('uses a stronger model, medium reasoning and sufficient output budget with private structured responses', async () => {
    let captured;
    global.fetch = async (url, options) => {
        assert.equal(url, 'https://api.openai.com/v1/responses');
        assert.ok(options.signal instanceof AbortSignal);
        captured = JSON.parse(options.body);
        return provider(estimate());
    };
    await request({ entry: '30 min run', weightKg: 72.5 });
    assert.equal(captured.model, 'gpt-5.4-mini');
    assert.equal(captured.reasoning.effort, 'medium');
    assert.ok(captured.max_output_tokens >= 4096);
    assert.equal(captured.store, false);
    assert.equal(captured.text.format.strict, true);
    assert.deepEqual(JSON.parse(captured.input), { entry: '30 min run', context: { weightKg: 72.5 } });
    assert.match(captured.instructions, /explicit body weight in the entry overrides context.weightKg/);
});

test('allows a server-side model override', async () => {
    process.env.OPENAI_CALORIE_MODEL = 'configured-reasoning-model';
    global.fetch = async (_, options) => {
        assert.equal(JSON.parse(options.body).model, 'configured-reasoning-model');
        return provider(estimate());
    };
    assert.equal((await request()).statusCode, 200);
});

test('accepts the legacy food field', async () => {
    assert.equal((await request({ food: 'yogurt' })).statusCode, 200);
});

for (const [name, body] of [
    ['null JSON', null], ['array JSON', []], ['number JSON', 4], ['invalid JSON', '{'],
    ['missing entry', {}], ['empty entry', { entry: ' ' }], ['oversized entry', { entry: 'x'.repeat(201) }],
    ['non-numeric weight', { entry: 'walking', weightKg: '70' }],
    ['out of range weight', { entry: 'walking', weightKg: 681 }]
]) {
    test('rejects ' + name + ' before calling the provider', async () => {
        global.fetch = async () => { assert.fail('Provider must not be called'); };
        assert.equal((await request(body)).statusCode, 400);
    });
}

test('returns configuration failure without calling the provider', async () => {
    delete process.env.OPENAI_API_KEY;
    global.fetch = async () => { assert.fail('Provider must not be called'); };
    assert.equal((await request()).statusCode, 503);
});

test('permits same-host local Safari requests and deployed app origins', async () => {
    for (const [origin, host] of [
        ['http://127.0.0.1:3001', '127.0.0.1:3001'],
        ['http://localhost:3002', 'localhost:3002'],
        ['https://mytracker-lat.vercel.app', 'mytracker-lat.vercel.app'],
        ['https://mytracker.lat', 'mytracker-lat.vercel.app']
    ]) {
        const result = await request(undefined, { method: 'OPTIONS', headers: { origin, host } });
        assert.equal(result.statusCode, 204);
        assert.equal(result.headers['Access-Control-Allow-Origin'], origin);
    }
});

test('rejects unrelated origins and a loopback origin that does not match the local server host', async () => {
    for (const origin of ['https://evil.example', 'http://localhost:9999', 'not a URL']) {
        const result = await request(undefined, { headers: { origin, host: 'localhost:3001' } });
        assert.equal(result.statusCode, 403);
        assert.equal(result.headers['Access-Control-Allow-Origin'], undefined);
    }
});

test('rejects non-POST methods and returns allowed methods', async () => {
    const result = await request(undefined, { method: 'GET' });
    assert.equal(result.statusCode, 405);
    assert.equal(result.headers.Allow, 'POST, OPTIONS');
});

test('turns provider rate limiting into a retryable error without exposing provider details', async () => {
    global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'sensitive internal detail' } }) });
    const result = await request();
    assert.equal(result.statusCode, 503);
    assert.match(result.body.error, /busy/);
    assert.doesNotMatch(result.body.error, /sensitive/);
});

test('handles timeout and other network failures without hanging or recording data', async () => {
    global.fetch = async () => { throw new DOMException('timed out', 'TimeoutError'); };
    assert.equal((await request()).statusCode, 504);
    global.fetch = async () => { throw new Error('connection reset'); };
    assert.equal((await request()).statusCode, 502);
});

test('rejects incomplete output even if it contains parseable estimate JSON', async () => {
    global.fetch = async () => provider(estimate(), { status: 'incomplete' });
    assert.equal((await request()).statusCode, 502);
});

test('handles provider refusal as an actionable input problem', async () => {
    global.fetch = async () => provider(null, { output: [{ content: [{ type: 'refusal', refusal: 'no' }] }] });
    assert.equal((await request()).statusCode, 422);
});

for (const [name, overrides] of [
    ['negative quantity', { items: [{ label: 'Food', quantity: -1, unit: 'serving', calories_per_unit: 100 }] }],
    ['string calories', { items: [{ label: 'Food', quantity: 1, unit: 'serving', calories_per_unit: '100' }] }],
    ['total above the entry limit', { items: [{ label: 'Food', quantity: 200, unit: 'serving', calories_per_unit: 100 }] }],
    ['no breakdown', { items: [] }],
    ['unknown category', { category: 'other' }],
    ['invalid confidence', { confidence: 'certain' }],
    ['blank label', { label: ' ' }],
    ['non-array assumptions', { assumptions: 'none' }],
    ['food activity mismatch', { activities: [{ label: 'Run', minutes: 30, met: 8, weight_kg: 70 }] }],
    ['invalid activity weight', { category: 'exercise', items: [], activities: [{ label: 'Run', minutes: 30, met: 8, weight_kg: -70 }] }]
]) {
    test('rejects malformed provider output: ' + name, async () => {
        global.fetch = async () => provider(estimate(overrides));
        const result = await request();
        assert.equal(result.statusCode, 502);
        assert.equal(result.body.calories, undefined);
    });
}

test('rejects invalid provider JSON and multiple output estimates', async () => {
    global.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } });
    assert.equal((await request()).statusCode, 502);
    global.fetch = async () => provider(estimate(), { output: [{ content: [
        { type: 'output_text', text: JSON.stringify(estimate()) },
        { type: 'output_text', text: JSON.stringify(estimate()) }
    ] }] });
    assert.equal((await request()).statusCode, 502);
});
