'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const store = readFileSync(join(__dirname, 'store.html'), 'utf8');

test('software images require an explicit product-ID verification mapping', () => {
  assert.match(store, /const VERIFIED_SOFTWARE_IMAGE_URLS=Object\.freeze\(\{\}\);/);
  assert.match(store, /const verifiedImageUrl=item=>https\(VERIFIED_SOFTWARE_IMAGE_URLS\[String\(item\.id\|\|''\)\]\);/);
  assert.doesNotMatch(store, /https\(item\.image_url\)/);
});

test('unverified or unavailable images never render placeholder text', () => {
  assert.doesNotMatch(store, /IMAGE NOT AVAILABLE|IMAGE PREVIEW UNAVAILABLE|image-unavailable/);
  assert.match(store, /if\(imgUrl\)\{const cover=el\('div'\);cover\.className='software-cover'/);
  assert.match(store, /img\.onerror=\(\)=>cover\.remove\(\)/);
});

test('expanded detail preview is omitted when no verified image exists or image loading fails', () => {
  assert.match(store, /detailMedia\.hidden=!src/);
  assert.match(store, /detailMedia\.hidden=true/);
  assert.match(store, /#software-detail-media\[hidden\]\{display:none!important\}/);
});

test('catalogue API, detail dialog and existing request action remain connected', () => {
  assert.match(store, /fetch\('\/api\/software-products'/);
  assert.match(store, /id="software-detail-dialog"/);
  assert.match(store, /detailRequest\?\.addEventListener\('click'/);
  assert.match(store, /forum_customer_requests/);
});

test('listing cards show a compact description excerpt while detail dialog keeps the full description', () => {
  assert.match(store, /const detailText=cleanDetails\(item\);/);
  assert.match(store, /detailText\.length>240\?detailText\.slice\(0,240\)/);
  assert.match(store, /summary\.className='software-details';card\.append\(summary\)/);
  assert.match(store, /detailDescription\.textContent=cleanDetails\(item\)/);
  assert.match(store, /-webkit-line-clamp:4/);
});
