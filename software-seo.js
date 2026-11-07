'use strict';

const SITE_ORIGIN = 'https://ecufileservice.in';
const MIN_DESCRIPTION_LENGTH = 120;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[character]);
}

function slugify(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'software';
}

function softwareCategory(product) {
  const text = (String(product?.title || '') + ' ' + String(product?.description || '')).toLowerCase();
  if (/airbag|srs|crash data/.test(text)) return 'Airbag and SRS';
  if (/immobilizer|immo|key program|transponder/.test(text)) return 'Immobilizer and Key Tools';
  if (/dashboard|cluster|speedometer|instrument/.test(text)) return 'Dashboard and Cluster';
  if (/dtc|obd|diagnos|scan tool|fault code/.test(text)) return 'Diagnostics and DTC';
  if (/ecu|ecm|winols|ktag|kess|pcm|tuning/.test(text)) return 'ECU and ECM Tools';
  return 'Automotive Software';
}

function isIndexableSoftwareProduct(product) {
  const description = String(product?.description || '').replace(/\s+/g, ' ').trim();
  return Boolean(product?.id && UUID_PATTERN.test(String(product.id)) &&
    product?.is_published === true && String(product?.title || '').trim().length >= 3 &&
    description.length >= MIN_DESCRIPTION_LENGTH);
}

function softwareProductPath(product) {
  return '/software/' + slugify(product?.title) + '-' + String(product?.id || '').toLowerCase();
}

function softwareProductUrl(product) {
  return SITE_ORIGIN + softwareProductPath(product);
}

function seoDescription(product) {
  const clean = String(product?.description || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= 160) return clean;
  return clean.slice(0, 157).replace(/\s+\S*$/, '') + '...';
}

function renderSoftwareProductPage(product) {
  if (!isIndexableSoftwareProduct(product)) return null;
  const title = String(product.title).trim();
  const description = String(product.description).replace(/\s+/g, ' ').trim();
  const category = softwareCategory(product);
  const canonical = softwareProductUrl(product);
  const metaDescription = seoDescription(product);
  const paragraphs = description.split(/\n+/).map(part => part.trim()).filter(Boolean)
    .map(part => '<p>' + escapeHtml(part) + '</p>').join('\n');
  const image = /^https:\/\//i.test(String(product.image_url || ''))
    ? '<img class="software-detail-image" src="' + escapeHtml(product.image_url) + '" alt="' + escapeHtml(title) + '" loading="lazy" decoding="async">'
    : '';
  const version = product.version ? '<p><strong>Version:</strong> ' + escapeHtml(product.version) + '</p>' : '';
  const price = product.price_visible && Number.isSafeInteger(Number(product.price_paise)) && Number(product.price_paise) > 0
    ? '<p><strong>Price:</strong> ₹' + (Number(product.price_paise) / 100).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + '</p>'
    : '<p><strong>Price:</strong> Request price</p>';
  const detailLink = /^https:\/\//i.test(String(product.product_url || ''))
    ? '<p><a href="' + escapeHtml(product.product_url) + '" rel="noopener noreferrer">View product details</a></p>' : '';
  const enquiryUrl = /^https:\/\//i.test(String(product.contact_url || '')) ? product.contact_url : '/store.html';
  const structured = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: title + ' | ECU File Service India',
    description: metaDescription,
    url: canonical,
    inLanguage: 'en',
    isPartOf: {'@type': 'WebSite', name: 'ECU File Service India', url: SITE_ORIGIN + '/'}
  };
  const jsonLd = JSON.stringify(structured).replace(/</g, '\\u003c');
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>' + escapeHtml(title) + ' | ' + escapeHtml(category) + ' | ECU File Service India</title>'
    + '<meta name="description" content="' + escapeHtml(metaDescription) + '">'
    + '<meta name="robots" content="index,follow"><link rel="canonical" href="' + escapeHtml(canonical) + '">'
    + '<meta property="og:type" content="website"><meta property="og:title" content="' + escapeHtml(title) + '">'
    + '<meta property="og:description" content="' + escapeHtml(metaDescription) + '"><meta property="og:url" content="' + escapeHtml(canonical) + '">'
    + '<link rel="stylesheet" href="/styles.css"><script type="application/ld+json">' + jsonLd + '</script>'
    + '<style>.software-detail{max-width:900px;margin:40px auto;padding:28px;background:#111b2b;border:1px solid #29384d;border-radius:18px;color:#edf3fb}.software-detail a{color:#83c5ff}.software-detail-image{display:block;max-width:100%;max-height:360px;object-fit:contain;border-radius:12px;margin:20px 0}.software-detail p{line-height:1.75}.software-detail .eyebrow{color:#9db5cf;text-transform:uppercase;letter-spacing:.08em;font-size:.78rem}.software-detail .cta{display:inline-block;margin-top:18px;padding:12px 18px;background:#2369a8;color:#fff;text-decoration:none;border-radius:9px;font-weight:700}</style>'
    + '</head><body><main class="software-detail"><p class="eyebrow"><a href="/">Home</a> / <a href="/store.html">Software Store</a> / ' + escapeHtml(category) + '</p>'
    + '<h1>' + escapeHtml(title) + '</h1>' + image + version + price + paragraphs + detailLink
    + '<a class="cta" href="' + escapeHtml(enquiryUrl) + '">Enquire about this software</a>'
    + '<p><small>Check compatibility, licence terms and supported vehicles with the provider before purchase.</small></p></main></body></html>';
}

function buildSoftwareSitemapEntries(products, lastmod = new Date().toISOString().slice(0, 10)) {
  return (Array.isArray(products) ? products : []).filter(isIndexableSoftwareProduct)
    .map(product => '<url><loc>' + escapeXml(softwareProductUrl(product)) + '</loc><lastmod>'
      + escapeXml(/^\d{4}-\d{2}-\d{2}$/.test(String(product.updated_at || '').slice(0, 10))
        ? String(product.updated_at).slice(0, 10)
        : (/^\d{4}-\d{2}-\d{2}$/.test(String(product.created_at || '').slice(0, 10))
          ? String(product.created_at).slice(0, 10) : lastmod))
      + '</lastmod></url>').join('');
}

function productIdFromPath(pathname) {
  const match = String(pathname || '').match(/^\/software\/(?:[a-z0-9-]+-)?([0-9a-f-]{36})\/?$/i);
  return match && UUID_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
}

module.exports = {
  MIN_DESCRIPTION_LENGTH, buildSoftwareSitemapEntries, isIndexableSoftwareProduct,
  productIdFromPath, renderSoftwareProductPage, slugify, softwareCategory,
  softwareProductPath, softwareProductUrl
};
