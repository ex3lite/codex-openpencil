import { readFile, writeFile } from 'node:fs/promises';

const sourcePath = process.argv[2];
if (!sourcePath) throw Error('Usage: node scripts/sync-openbrush-design.mjs /path/to/OpenBrush-Interface.op');
const design = JSON.parse(await readFile(sourcePath, 'utf8'));
const nodes = new Map();
function visit(node) {
  nodes.set(node.id, node);
  for (const child of node.children ?? []) visit(child);
}
for (const page of design.pages) for (const node of page.children) visit(node);

function layer(id) {
  const node = nodes.get(id);
  if (!node) throw Error(`Missing design layer: ${id}`);
  return node;
}
const header = layer('ob-r-120');
const dock = layer('ob-r-214');
const picker = layer('ob-flow-picker-modal');
const card = layer('ob-flow-card-master');
const search = layer('ob-flow-30');
const firstRow = layer('ob-flow-36');
const secondRow = layer('ob-flow-38');
const emptyTitle = layer('ob-flow-43');
const emptyDescription = layer('ob-flow-44');
const editor = layer('ob-f-119');
const library = layer('ob-f-557');
const layersTabs = layer('ob-spacing-ob-f-119-layer-tabs');
const layerPanel = layer('ob-r-122');
const inspectorPanel = layer('ob-r-124');
const inspectorDivider = layer('ob-r-233');
const attachAction = layer('ob-instance-231');
const commentAction = layer('ob-instance-232');
const px = number => {
  if (!Number.isFinite(number)) throw Error(`Expected a numeric measurement, got ${number}`);
  return `${number}px`;
};
const dimensions = {
  'context-card-height': layer('ob-r-385').height, 'context-input-height': layer('ob-r-394').height,
  inset: header.x, 'header-height': header.height, 'header-gap': header.gap,
  'panel-radius': picker.cornerRadius, 'panel-top': library.y, 'layers-width': layer('ob-r-122').width,
  'inspector-width': layer('ob-r-124').width, 'dock-width': dock.width, 'dock-height': dock.height,
  'dock-radius': dock.cornerRadius, 'dock-inset': editor.height - dock.y - dock.height,
  'dock-padding': dock.padding[0], 'dock-gap': dock.gap, 'tool-gap': layer(dock.children[0].id).gap,
  'tool-size': layer('ob-master-16').width, 'tool-radius': layer('ob-master-16').cornerRadius,
  'layer-tabs-top': layersTabs.y, 'layer-tabs-side': layersTabs.x,
  'layer-tabs-gap': layersTabs.gap, 'layer-tabs-width': layersTabs.width,
  'layer-tab-width': layer('ob-instance-137').descendants[layer('ob-instance-137').ref].width,
  'layer-tab-height': layersTabs.height,
  'inspector-content-height': inspectorDivider.y,
  'inspector-divider-top': layer('ob-r-226').y,
  'inspector-title-top': layer('ob-t-224').y, 'inspector-title-left': layer('ob-t-224').x,
  'inspector-close-top': layer('ob-instance-225').y,
  'inspector-close-right': inspectorPanel.width - layer('ob-instance-225').x - layer('ob-master-44').width,
  'inspector-selection-top': layer('ob-t-229').y,
  'inspector-selection-meta-top': layer('ob-t-230').y,
  'inspector-action-left': attachAction.x, 'inspector-attach-top': attachAction.y,
  'inspector-comment-top': commentAction.y,
  'inspector-action-height': layer(attachAction.ref).height,
  'layer-search-top': layer('ob-instance-154').y,
  'layer-search-right': layerPanel.width - layer('ob-instance-154').x - layer('ob-master-48').width,
  'picker-width': picker.width, 'picker-height': picker.height, 'picker-padding': search.x,
  'picker-columns-gap': layer('ob-flow-37').x - layer('ob-flow-36').x - card.width,
  'picker-search-height': search.height, 'picker-search-radius': search.cornerRadius,
  'picker-card-height': card.height, 'picker-card-radius': card.cornerRadius,
  'picker-card-padding': layer('ob-flow-32').x, 'picker-heading-size': layer('ob-flow-27').fontSize,
  'picker-card-title-size': layer('ob-flow-33').fontSize,
  'picker-footer-gap': layer('ob-flow-40').y - secondRow.y - card.height,
  'picker-empty-top': emptyTitle.y - firstRow.y,
  'picker-empty-width': emptyTitle.width,
  'picker-empty-height': secondRow.y + card.height - firstRow.y,
  'picker-empty-description-gap': emptyDescription.y - emptyTitle.y - emptyTitle.height,
  'picker-empty-action-gap': layer('ob-flow-45').y - emptyDescription.y - emptyDescription.height,
};
const colors = ['accent','border','canvas','danger','hover','ink','muted','raised','selected','surface','success','paperInk'];
const tokens = Object.entries(dimensions).map(([key,value]) => `  --ob-${key}: ${px(value)};`);
for (const name of colors) {
  const value = design.variables?.[`brush-${name}`]?.value;
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw Error(`Missing color token: ${name}`);
  tokens.push(`  --ob-${name}: ${value};`);
}
for (const name of ['control','panel']) {
  const value = design.variables?.[`brush-duration-${name}`]?.value;
  if (!Number.isFinite(value)) throw Error(`Missing motion token: ${name}`);
  tokens.push(`  --ob-motion-${name}: ${value}ms;`);
}

// Reuse the referenced Coolicons vectors at their authored position and scale.
function icon(name, node) {
  const paths = node.children.map(path => {
    if (path.type !== 'path' || !/^[a-z0-9.,\s-]+$/i.test(path.d)) throw Error(`Unsupported vector in ${node.id}`);
    if (path.iconId === 'openpencil:icon-path-refit' && /^M [\d.]+ 0 L [\d.]+ 0$/.test(path.d)) {
      return `<path d="M ${path.x} ${path.y} h ${path.width}" stroke-width="${path.stroke.thickness}"/>`;
    }
    const scale = node.width / 24;
    return `<path d="${path.d}" transform="translate(${path.x ?? 0} ${path.y ?? 0}) scale(${scale})" stroke-width="${path.stroke.thickness / scale}"/>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${node.width} ${node.height}" fill="none" stroke="black" stroke-linejoin="round" stroke-linecap="round">${paths.join('')}</svg>`;
  return `[data-ob-icon="${name}"] { --ob-icon: url("data:image/svg+xml,${encodeURIComponent(svg)}"); }`;
}
const icons = {
  brand: layer('ob-f-129'), library: layer('ob-f-14'), context: layer('ob-f-104'),
};
for (const [name,id] of Object.entries({
  select:'ob-master-16', frame:'ob-master-20', text:'ob-master-24', hand:'ob-master-28',
  comment:'ob-master-32', layers:'ob-master-36', inspector:'ob-master-40', close:'ob-master-44', search:'ob-master-48',
  plus:'ob-master-52', minus:'ob-master-56', more:'ob-master-60', play:'ob-master-72',
})) icons[name] = layer(id).children[0];

// The editable source owns each control rectangle in the text inspector.
const inspectorParts = {
 position:'ob-t-234', x:'ob-f-237', y:'ob-f-240', width:'ob-f-243', height:'ob-f-246',
 'text-rule':'ob-r-247', text:'ob-t-248', family:'ob-r-249', weight:'ob-f-255', size:'ob-f-258',
 leading:'ob-f-261', tracking:'ob-f-264', 'fill-rule':'ob-r-265', 'fill-heading':'ob-t-266',
 'fill-row':'ob-spacing-ob-f-119-fill-row', 'styles-rule':'ob-r-270', styles:'ob-t-271', binding:'ob-t-274',
};
const inspectorRules = Object.entries(inspectorParts).map(([key, id]) => {
  const node = layer(id);
  return `[data-inspector-part="${key}"] { left:${px(node.x)}; top:${px(node.y - inspectorDivider.y)}; width:${px(node.width)}; height:${px(node.height)}; }`;
});
const css = [
  '/* Generated from OpenBrush-Interface.op by scripts/sync-openbrush-design.mjs. */',
  ':root {', ...tokens, '}', '',
  ...inspectorRules, '', ...Object.entries(icons).map(([name, node]) => icon(name, node)), '',
].join('\n');
const output = new URL('../plugins/openpencil/ui/native-design.css', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== css) throw Error('The implementation tokens differ from the source .op design.');
} else {
  await writeFile(output, css);
}
