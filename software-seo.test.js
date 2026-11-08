'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildSoftwareSitemapEntries,
  isIndexableSoftwareProduct,
  publicProductTitle,
  productIdFromPath,
  renderSoftwareProductPage,
  softwareCategory,
  softwareProductPath,
  softwareProductUrl
} = require('./software-seo');

const id = '123e4567-e89b-42d3-a456-426614174000';
const validProduct = {
  id, title: 'ECU Diagnostic Utility', is_published: true,
  description: 'A workshop diagnostic utility for identifying supported electronic control unit communication and fault-code information. Confirm compatibility with the exact vehicle, control module and interface before use.',
  version: '2.0', price_visible: false, created_at: '2026-11-07T00:00:00Z'
};

test('only published products with meaningful descriptions are indexable', () => {
  assert.equal(isIndexableSoftwareProduct(validProduct), true);
  assert.equal(isIndexableSoftwareProduct({...validProduct, is_published: false}), false);
  assert.equal(isIndexableSoftwareProduct({...validProduct, description: ''}), false);
  assert.equal(isIndexableSoftwareProduct({...validProduct, description: 'Short description'}), false);
  assert.equal(isIndexableSoftwareProduct({...validProduct, id: 'not-a-uuid'}), false);
});

test('product URLs use a readable slug and stable product id', () => {
  assert.equal(softwareProductPath(validProduct), '/software/ecu-diagnostic-utility-' + id);
  assert.equal(softwareProductUrl(validProduct), 'https://ecufileservice.in/software/ecu-diagnostic-utility-' + id);
  assert.equal(productIdFromPath(softwareProductPath(validProduct)), id);
  assert.equal(productIdFromPath('/software/not-a-product'), null);
});

test('category inference uses existing product details', () => {
  assert.equal(softwareCategory(validProduct), 'Diagnostics and DTC');
  assert.equal(softwareCategory({...validProduct, title: 'Airbag SRS Tool'}), 'Airbag and SRS');
});

test('sitemap includes only eligible published products and escapes XML', () => {
  const entries = buildSoftwareSitemapEntries([
    validProduct,
    {...validProduct, id: '123e4567-e89b-42d3-a456-426614174001', title: 'Hidden', is_published: false},
    {...validProduct, id: '123e4567-e89b-42d3-a456-426614174002', title: 'No details', description: ''}
  ]);
  assert.equal((entries.match(/<url>/g) || []).length, 1);
  assert.match(entries, /ecu-diagnostic-utility/);
  assert.match(buildSoftwareSitemapEntries([{...validProduct, title: 'ECU & OBD Utility'}]), /ecu-obd-utility/);
});

test('product HTML has unique metadata, canonical, safe escaping and no fake product offer data', () => {
  const html = renderSoftwareProductPage({...validProduct, title: 'ECU <Utility>', description: validProduct.description + ' Additional supported information.'});
  assert.match(html, /<title>ECU &lt;Utility&gt;/);
  assert.match(html, /name="robots" content="index,follow"/);
  assert.match(html, /rel="canonical"/);
  assert.match(html, /application\/ld\+json/);
  assert.match(html, /Request price/);
  assert.doesNotMatch(html, /"@type":"Product"/);
  assert.doesNotMatch(html, /<Utility>/);
});


test('public software descriptions omit licence-status wording while retaining useful product detail', () => {
  const html = renderSoftwareProductPage({...validProduct, description: 'This licensed utility has a licence type and licence terms. Confirm supported ECU details before purchase. Technicians should identify the exact control module, software build and communication interface before choosing a package.'});
  assert.doesNotMatch(html, /licen[cs]e|licensing/i);
  assert.match(html, /compatible utility/);
  assert.match(html, /software edition/);
  assert.match(html, /package details/);
});


test('software detail pages normalize public titles and split escaped paragraphs', () => {
  const titlePage = renderSoftwareProductPage({...validProduct, title: 'Winols'});
  assert.match(titlePage, /<title>EVC WinOLS V4\.7/);
  assert.match(titlePage, /class="software-detail-cover"/);
  const description = 'First paragraph contains enough context about the ECU software, its purpose and the supported workflow.\\n\\nSecond paragraph explains that technicians should confirm the exact vehicle, module and interface before choosing a package.';
  const page = renderSoftwareProductPage({...validProduct, description});
  assert.match(page, /<p>First paragraph contains enough context/);
  assert.match(page, /<p>Second paragraph explains/);
  assert.doesNotMatch(page, /\\\\n/);
  assert.equal(publicProductTitle({...validProduct, title: 'Odis'}), 'ODIS Service V26');
});
