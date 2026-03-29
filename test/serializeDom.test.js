import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serializeDom } from '../lib/serializeDom.js';

describe('serializeDom', () => {
  it('serializes tag node to HTML', () => {
    const node = ['DIV', { class: 'foo' }, 'hello'];
    assert.equal(serializeDom(node), '<DIV class="foo">hello</DIV>');
  });

  it('serializes nested elements', () => {
    const node = ['DIV', {}, ['SPAN', {}, 'text']];
    assert.equal(serializeDom(node), '<DIV><SPAN>text</SPAN></DIV>');
  });

  it('handles void elements (no closing tag)', () => {
    const node = ['BR', {}];
    assert.equal(serializeDom(node), '<BR>');
  });

  it('handles void elements with attributes', () => {
    const node = ['IMG', { src: 'a.png', alt: 'test' }];
    assert.equal(serializeDom(node), '<IMG src="a.png" alt="test">');
  });

  it('escapes HTML entities in text nodes', () => {
    const node = ['P', {}, '<script>alert("xss")</script>'];
    // Quotes don't need escaping in text content, only in attributes
    assert.equal(serializeDom(node), '<P>&lt;script&gt;alert("xss")&lt;/script&gt;</P>');
  });

  it('handles multiple children', () => {
    const node = ['UL', {}, ['LI', {}, 'one'], ['LI', {}, 'two']];
    assert.equal(serializeDom(node), '<UL><LI>one</LI><LI>two</LI></UL>');
  });

  it('handles dedup ref that resolves from refMap', () => {
    const refMap = new Map();
    refMap.set(1, '<SPAN>cached</SPAN>');
    const node = [[0, 1]];
    assert.equal(serializeDom(node, refMap), '<SPAN>cached</SPAN>');
  });

  it('invalid dedup ref → returns <!-- dedup-ref-error --> + warns, does not crash', () => {
    const warnings = [];
    const node = [[0, 99]];
    const result = serializeDom(node, new Map(), warnings);
    assert.equal(result, '<!-- dedup-ref-error -->');
    assert.ok(warnings.length > 0, 'Should have warning');
    assert.ok(warnings[0].includes('99'));
  });

  it('handles null/undefined input', () => {
    assert.equal(serializeDom(null), '');
    assert.equal(serializeDom(undefined), '');
  });

  it('handles empty array', () => {
    assert.equal(serializeDom([]), '');
  });

  it('handles text-only node (string)', () => {
    assert.equal(serializeDom('hello world'), 'hello world');
  });

  it('handles numeric text node', () => {
    assert.equal(serializeDom(42), '42');
  });

  it('handles boolean attributes', () => {
    const node = ['INPUT', { disabled: true, type: 'text' }];
    assert.equal(serializeDom(node), '<INPUT disabled type="text">');
  });
});
