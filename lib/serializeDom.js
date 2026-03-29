/**
 * Serialize Playwright's DOM tree array format to HTML string.
 *
 * PW represents DOM as nested arrays:
 *   ["TAG", {attr: val}, child1, child2, ...]
 * Where children can be strings (text nodes) or nested arrays (elements).
 *
 * Special cases:
 *   - Dedup ref: [[idx, refIdx]] — reference to a previously seen node
 *   - String — text node
 *
 * @param {any} node - DOM tree node (array, string, or dedup ref)
 * @param {Map} [refMap] - map of index -> serialized HTML for dedup resolution
 * @param {string[]} [warnings] - accumulator for warnings
 * @returns {string} HTML string
 */
export function serializeDom(node, refMap = new Map(), warnings = []) {
  if (node == null) return '';

  // Text node
  if (typeof node === 'string') {
    return escapeHtml(node);
  }

  // Number (sometimes PW emits numeric text)
  if (typeof node === 'number') {
    return String(node);
  }

  if (!Array.isArray(node)) {
    return '';
  }

  // Check for dedup ref: [[idx, refIdx]]
  if (node.length === 1 && Array.isArray(node[0]) && node[0].length === 2 &&
      typeof node[0][0] === 'number' && typeof node[0][1] === 'number') {
    const [, refIdx] = node[0];
    if (refMap.has(refIdx)) {
      return refMap.get(refIdx);
    }
    warnings.push(`Unresolved dedup ref: ${refIdx}`);
    return '<!-- dedup-ref-error -->';
  }

  // Element node: ["TAG", {attrs}, ...children]
  if (node.length === 0) return '';

  const tag = node[0];
  if (typeof tag !== 'string') {
    // Could be an array of children
    return node.map(child => serializeDom(child, refMap, warnings)).join('');
  }

  // Extract attributes (second element if it's a plain object)
  let attrs = {};
  let childStart = 1;
  if (node.length > 1 && node[1] && typeof node[1] === 'object' && !Array.isArray(node[1])) {
    attrs = node[1];
    childStart = 2;
  }

  // Void elements (no closing tag)
  const voidElements = new Set([
    'AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT',
    'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR',
  ]);

  const attrStr = Object.entries(attrs)
    .map(([k, v]) => v === true ? k : `${k}="${escapeAttr(String(v))}"`)
    .join(' ');

  const openTag = attrStr ? `<${tag} ${attrStr}>` : `<${tag}>`;

  if (voidElements.has(tag.toUpperCase())) {
    return openTag;
  }

  // Serialize children
  const children = node.slice(childStart);
  const childHtml = children.map(child => serializeDom(child, refMap, warnings)).join('');

  return `${openTag}${childHtml}</${tag}>`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
