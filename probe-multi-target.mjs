import { parsePresentationScript } from './lib/canvas-player-core.js';

const script = [
  '---',
  'canvas: "[[X.canvas]]"',
  '---',
  '',
  '## Step 0',
  'show: [[A]], [[B]], [Group C]',
  'in-focus: [[A]], [[B]]',
  '',
  '## Step 1',
  'hide: [[A]], [Group C]',
  'out-focus: [[A]], [[B]], [Group C]',
].join('\n');

console.log(JSON.stringify(parsePresentationScript(script).steps, null, 2));
