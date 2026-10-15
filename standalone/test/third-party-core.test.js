'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/third-party-core.js');

const PAGE = 'https://minmagic.ru/oferta?utm_source=x#top';

function rec(over) {
	return Object.assign({
		url: 'https://app.getreview.io/tags/abc/sdk.js',
		type: 'script',
		source: 'script',
		at: 1000,
		end: null,
		state: 'loading',
		script: '',
		stack: '',
		async: true,
		head: true
	}, over);
}

test('hostOf lowercases and drops port, query and non-http urls', () => {
	assert.equal(C.hostOf('https://App.GetReview.io:8443/tags/x/sdk.js?a=1'), 'app.getreview.io');
	assert.equal(C.hostOf('http://mc.yandex.ru/watch/1'), 'mc.yandex.ru');
	assert.equal(C.hostOf('data:image/png;base64,AAAA'), '');
	assert.equal(C.hostOf(''), '');
	assert.equal(C.hostOf(undefined), '');
});

test('stripUrl keeps origin and path only', () => {
	assert.equal(C.stripUrl('https://a.ru/x/y.js?token=1#h'), 'https://a.ru/x/y.js');
	assert.equal(C.stripUrl('https://a.ru'), 'https://a.ru/');
	assert.equal(C.stripUrl('https://a.ru:8443/p?q'), 'https://a.ru:8443/p');
	assert.equal(C.stripUrl('blob:https://a.ru/1'), '');
});

test('stackUrls parses Chrome and Firefox stacks, innermost first', () => {
	const chrome = [
		'Error',
		'    at track (https://minmagic.ru/oferta:12:40)',
		'    at Node.appendChild (https://minmagic.ru/oferta:20:5)',
		'    at r (https://stat1.clickfraud.ru/js/container_y6FzSWjC.js:1:2200)',
		'    at https://stat1.clickfraud.ru/js/container_y6FzSWjC.js:1:900'
	].join('\n');
	assert.deepEqual(C.stackUrls(chrome), [
		'https://minmagic.ru/oferta',
		'https://stat1.clickfraud.ru/js/container_y6FzSWjC.js'
	]);
	const firefox = 'track@https://minmagic.ru/oferta:12:40\nr@https://cdn.example.com:8443/a.js:3:7\n';
	assert.deepEqual(C.stackUrls(firefox), ['https://minmagic.ru/oferta', 'https://cdn.example.com:8443/a.js']);
	assert.deepEqual(C.stackUrls(''), []);
});

test('pickInitiator: html source', () => {
	assert.deepEqual(C.pickInitiator(rec({ source: 'html' }), PAGE), { initiator: 'html', chain: [] });
});

test('pickInitiator: currentScript wins', () => {
	const r = rec({ script: 'https://stat1.clickfraud.ru/js/container.js', stack: 'at x (https://minmagic.ru/oferta:1:1)' });
	assert.equal(C.pickInitiator(r, PAGE).initiator, 'https://stat1.clickfraud.ru/js/container.js');
	assert.deepEqual(C.pickInitiator(r, PAGE).chain, ['stat1.clickfraud.ru']);
});

test('pickInitiator: outermost external frame after dropping loader frames', () => {
	const r = rec({
		stack: [
			'Error',
			'    at track (https://minmagic.ru/oferta:12:40)',
			'    at https://static.tildacdn.com/js/jquery-1.10.2.min.js:4:100',
			'    at https://stat1.clickfraud.ru/js/container.js:1:900'
		].join('\n')
	});
	const ini = C.pickInitiator(r, PAGE);
	assert.equal(ini.initiator, 'https://stat1.clickfraud.ru/js/container.js');
	assert.deepEqual(ini.chain, ['static.tildacdn.com', 'stat1.clickfraud.ru']);
});

test('pickInitiator: inline when the outermost frame is the page itself', () => {
	const r = rec({
		stack: [
			'Error',
			'    at track (https://minmagic.ru/oferta:12:40)',
			'    at https://static.tildacdn.com/js/jquery-1.10.2.min.js:4:100',
			'    at https://minmagic.ru/oferta:300:9'
		].join('\n')
	});
	assert.equal(C.pickInitiator(r, PAGE).initiator, 'inline');
	assert.equal(C.pickInitiator(rec({ stack: '' }), PAGE).initiator, 'inline');
});

test('classify: pending after threshold, loading before it', () => {
	const views = C.classify([rec({ at: 1000 })], [], 7000, { pageUrl: PAGE });
	assert.equal(views[0].state, 'pending');
	assert.equal(views[0].ageMs, 6000);
	assert.equal(C.classify([rec({ at: 1000 })], [], 3000, { pageUrl: PAGE })[0].state, 'loading');
});

test('classify: done via resource entry or load event, error wins', () => {
	const entry = { name: 'https://app.getreview.io/tags/abc/sdk.js', duration: 420.4, transferSize: 2048, encodedBodySize: 0 };
	const v = C.classify([rec()], [entry], 9000, { pageUrl: PAGE })[0];
	assert.equal(v.state, 'done');
	assert.equal(v.durationMs, 420);
	assert.equal(v.sizeBytes, 2048);
	const byEvent = C.classify([rec({ state: 'done', end: 1600 })], [], 9000, { pageUrl: PAGE })[0];
	assert.equal(byEvent.state, 'done');
	assert.equal(byEvent.durationMs, 600);
	assert.equal(C.classify([rec({ state: 'error', end: 1100 })], [entry], 9000, { pageUrl: PAGE })[0].state, 'error');
});

test('classify: skips self hosts, dedupes urls, strips query', () => {
	const views = C.classify([
		rec({ url: 'https://portal.arvexa.ru/perf/overlay.js' }),
		rec({ url: 'https://a.ru/x.js?t=1' }),
		rec({ url: 'https://a.ru/x.js?t=1', at: 2000 })
	], [], 3000, { selfHosts: ['portal.arvexa.ru'], pageUrl: PAGE });
	assert.equal(views.length, 1);
	assert.equal(views[0].url, 'https://a.ru/x.js');
});

test('classify: blocking = sync html script in head, or renderBlockingStatus', () => {
	const sync = rec({ url: 'https://s3.intickets.ru/intickets.js', source: 'html', async: false, head: true, state: 'done', end: 1500 });
	const asyncHtml = rec({ url: 'https://b.ru/a.js', source: 'html', async: true, head: true, state: 'done', end: 1500 });
	const css = rec({ url: 'https://c.ru/s.css', type: 'link', source: 'html', async: null, state: 'done', end: 1500 });
	const entries = [{ name: 'https://c.ru/s.css', duration: 100, transferSize: 10, renderBlockingStatus: 'blocking' }];
	const views = C.classify([sync, asyncHtml, css], entries, 9000, { pageUrl: PAGE });
	const by = {};
	views.forEach(function (v) { by[v.host] = v.blocking; });
	assert.deepEqual(by, { 's3.intickets.ru': true, 'b.ru': false, 'c.ru': true });
});

test('classify: sorts pending first, then error, loading, done', () => {
	const views = C.classify([
		rec({ url: 'https://done.ru/a.js', state: 'done', end: 1100 }),
		rec({ url: 'https://err.ru/a.js', state: 'error', end: 1100 }),
		rec({ url: 'https://hang.ru/a.js', at: 0 }),
		rec({ url: 'https://load.ru/a.js', at: 8000 })
	], [], 9000, { pageUrl: PAGE });
	assert.deepEqual(views.map(function (v) { return v.state; }), ['pending', 'error', 'loading', 'done']);
});

test('groupByHost merges resource entries with pending views', () => {
	const entries = [
		{ name: 'https://mc.yandex.ru/metrika/tag.js', duration: 300, transferSize: 90000 },
		{ name: 'https://mc.yandex.ru/watch/1', duration: 120, transferSize: 0 },
		{ name: 'https://portal.arvexa.ru/perf/overlay.js', duration: 50, transferSize: 100 }
	];
	const views = [{ host: 'app.getreview.io', state: 'pending', ageMs: 34000, blocking: false }];
	const groups = C.groupByHost(entries, views, { selfHosts: ['portal.arvexa.ru'], pageHost: 'minmagic.ru' });
	assert.equal(groups[0].host, 'app.getreview.io');
	assert.equal(groups[0].pending, 1);
	assert.equal(groups[0].slowestMs, 34000);
	assert.deepEqual(groups[1], { host: 'mc.yandex.ru', count: 2, transfer: 90000, slowestMs: 300, pending: 0, blocking: 0 });
	assert.equal(groups.length, 2);
});

test('cpuByHost sums script time from long animation frames', () => {
	const frames = [
		{ scripts: [{ sourceURL: 'https://mc.yandex.ru/metrika/tag.js', duration: 180 }, { sourceURL: '', duration: 30 }] },
		{ scripts: [{ sourceURL: 'https://mc.yandex.ru/metrika/tag.js', duration: 90 }, { sourceURL: 'https://portal.arvexa.ru/x.js', duration: 400 }] }
	];
	assert.deepEqual(C.cpuByHost(frames, { selfHosts: ['portal.arvexa.ru'] }), [{ host: 'mc.yandex.ru', ms: 270 }]);
	assert.deepEqual(C.cpuByHost([], {}), []);
});

test('loadHold reports pending requests only after the threshold', () => {
	const views = [{ host: 'app.getreview.io', state: 'pending' }, { host: 'a.ru', state: 'done' }];
	assert.equal(C.loadHold('complete', 30000, views), null);
	assert.equal(C.loadHold('interactive', 9000, views), null);
	const hold = C.loadHold('interactive', 34000, views);
	assert.equal(hold.sinceMs, 34000);
	assert.deepEqual(hold.pending.map(function (v) { return v.host; }), ['app.getreview.io']);
});

test('lookupService matches host or subdomain, not lookalikes', () => {
	assert.equal(C.lookupService('app.getreview.io').name, 'GetReview');
	assert.equal(C.lookupService('getreview.io').name, 'GetReview');
	assert.equal(C.lookupService('notgetreview.io'), null);
	assert.equal(C.lookupService('mc.yandex.ru').name, 'Yandex Metrica');
});

test('buildSnapshot strips queries and caps lists', () => {
	const views = [];
	for (let i = 0; i < 200; i++) {
		views.push({ url: 'https://a.ru/' + i + '.js?t=1', host: 'a.ru', type: 'script', source: 'script', initiator: 'https://b.ru/x.js?k=2', chain: ['b.ru'], state: 'done', ageMs: 1, durationMs: 1, sizeBytes: null, blocking: false });
	}
	const snap = C.buildSnapshot({
		loaderVersion: 1, overlayVersion: '0.3.0', pageUrl: PAGE, ua: 'UA', capturedAt: '2026-10-15T10:00:00.000Z',
		vitals: { ttfb: 120.55, lcp: 2400, cls: 0.01234, inp: null, longTasks: 3, lcpEntry: {} },
		dcl: 900, load: null, views: views, hosts: [], cpu: [], probe: null
	});
	assert.equal(snap.v, 1);
	assert.equal(snap.page, 'https://minmagic.ru/oferta');
	assert.equal(snap.requests.length, 150);
	assert.equal(snap.requests[0].url, 'https://a.ru/0.js');
	assert.equal(snap.requests[0].initiator, 'https://b.ru/x.js');
	assert.deepEqual(snap.vitals, { ttfb: 120.55, lcp: 2400, cls: 0.012, inp: null, longTasks: 3, dcl: 900, load: null });
	assert.equal(snap.probe, null);
});
