import test from 'node:test';
import assert from 'node:assert/strict';
import { transportDocument, liveDocument, diskDocument, snapshotMatches } from '../plugins/openpencil/scripts/document-format.mjs';

test('document transport deduplicates structural data images without rewriting free-form data', () => {
  const src = 'data:image/png;base64,' + 'a'.repeat(1024 * 1024);
  const document = { images: { existing: src, unused: 'keep-original-image' }, imageThumbs: { existing: 'keep-thumb' },
    variables: { value: src }, editorMeta: { activePageIndex: 2 },
    pages: [{ id: 'p', children: Array.from({ length: 300 }, (_, i) => ({ id: `i${i}`, type: 'image', src,
      fill: [{ type: 'image', url: src }], stroke: { fill: [{ type: 'image', url: src }] },
      states: { hover: { fill: [{ type: 'image', url: src }] }, custom: { value: 'data:keep-freeform' } } })) }] };
  const encoded = transportDocument(document);
  assert.equal(Object.keys(encoded.images).length, 2);
  assert.equal(encoded.pages[0].children[299].src, 'op-image:existing');
  assert.equal(encoded.pages[0].children[0].fill[0].url, 'op-image:existing');
  assert.equal(encoded.pages[0].children[0].stroke.fill[0].url, 'op-image:existing');
  assert.equal(encoded.pages[0].children[0].states.hover.fill[0].url, 'op-image:existing');
  assert.equal(encoded.variables.value, src);
  assert.equal(encoded.pages[0].children[0].states.custom.value, 'data:keep-freeform');
  assert.deepEqual(encoded.imageThumbs, document.imageThumbs);
  assert.deepEqual(encoded.editorMeta, document.editorMeta);
  assert.equal(encoded.images.unused, 'keep-original-image');
  assert.deepEqual(liveDocument(encoded), liveDocument(document));
  assert.equal(document.pages[0].children[0].src, src);
});
test('new inline shared images receive one table entry and canonical saves retain metadata', () => {
  const src = 'data:image/png;base64,abc';
  const live = { document: { pages: [{ id: 'p', children: [{ id: 'a', type: 'image', src }, { id: 'b', type: 'image', src }] }] },
    activePageIndex: 0, preserveAuthoredGeometry: true, scenario: { selected: 'kept' } };
  const disk = diskDocument(live), keys = Object.keys(disk.images);
  assert.equal(keys.length, 1);
  assert.equal(disk.pages[0].children[0].src, 'op-image:' + keys[0]);
  assert.equal(disk.pages[0].children[1].src, disk.pages[0].children[0].src);
  assert.deepEqual(disk.editorMeta.scenario, live.scenario);
  assert.equal(snapshotMatches(disk, live), true);
  assert.deepEqual(transportDocument(disk), disk);
});
