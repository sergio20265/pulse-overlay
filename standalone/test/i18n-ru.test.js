'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = {};
require('../src/i18n-ru.js');
const RU = global.window.__arvexaPerfRu;
const C = require('../src/third-party-core.js');

// Core strings that can appear in the standalone panel (no server data).
const CORE_VISIBLE = [
	'Arvexa Performance Overlay', 'Network', 'TTFB', 'Requests', 'Transferred', 'from cache',
	'Network bytes; cached responses count as 0', 'Rendering', 'LCP', 'LCP element',
	'Largest Contentful Paint element', 'CLS', 'INP', 'Worst interaction so far', 'DOM nodes', 'Long tasks', 'Components'
];

function literals(file) {
	const src = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
	const out = [];
	const re = /__\('([^']+)'/g;
	let m;
	while ((m = re.exec(src))) {
		out.push(m[1]);
	}
	return out;
}

test('every section string has a Russian translation', () => {
	const strings = literals('standalone/src/third-party-section.js');
	assert.ok(strings.length > 30, 'section strings were found');
	const missing = strings.filter(function (s) { return !Object.prototype.hasOwnProperty.call(RU, s); });
	assert.deepEqual(missing, []);
});

test('core LCP hints and visible core strings are translated', () => {
	const hints = literals('assets/arvexa-performance-overlay.js').filter(function (s) { return /^(LCP |Image is|Long gap|The LCP|Most of LCP)/.test(s); });
	const missing = CORE_VISIBLE.concat(hints).filter(function (s) { return !Object.prototype.hasOwnProperty.call(RU, s); });
	assert.deepEqual(missing, []);
});

test('service names and kinds are translated or proper nouns', () => {
	const proper = /^[A-Za-z][A-Za-z@.]*( [A-Z][A-Za-z]+)*$/; // Latin proper names: GetReview, jsDelivr, Google Tag Manager…
	const missing = [];
	C.SERVICES.forEach(function (s) {
		if (!RU[s.kind]) { missing.push(s.kind); }
		if (!RU[s.name] && !proper.test(s.name)) { missing.push(s.name); }
	});
	assert.deepEqual(missing, []);
});
