/**
 * publish-canvas-player.js
 *
 * Assembles the canvas-player viewer release and publishes it to the
 * shared drive: archives the current release (if any) as canvas-player-vN,
 * then copies the fresh files into a fixed canvas-player folder that
 * colleagues run directly, per tools/canvas-player.md [section
 * Distribution/Release Package].
 *
 * References (documents used to design this script):
 *   - tools/canvas-player.md [section Distribution]
 *   - conventions/tools.md [section Standard Interface]
 *
 * Not yet in references (document debt — update the refs to absorb these):
 *   - The list of files that make up a release (viewer-server.js,
 *     lib/server-core.js, lib/canvas-player-core.js, canvas-player.html,
 *     canvas-player.js, launch-canvas-player.bat) is hardcoded here, not
 *     stated in tools/canvas-player.md [section Distribution/Release Package].
 *   - The archived launcher is renamed to "Lancer Canvas Player.bat" in the
 *     published release — not specified in the doc.
 *
 * Args: <kb-tools-dir> <tools-dest-dir> [release-note]
 */

import fs   from 'fs';
import path from 'path';

const RELEASE_FILES = [
  'viewer-server.js',
  'canvas-player.html',
  'canvas-player.js',
  'lib/server-core.js',
  'lib/canvas-player-core.js',
];

const LAUNCHER_SOURCE = 'launch-canvas-player.bat';
const LAUNCHER_DEST   = 'Lancer Canvas Player.bat';

function fail(code, message) {
  console.log(`ERROR:${code}:${message}`);
  process.exit(0);
}

function main() {
  const [kbToolsDir, destRoot, releaseNote] = process.argv.slice(2);

  if (!kbToolsDir || !destRoot) {
    return fail('MISSING_ARG', 'Usage: node publish-canvas-player.js <kb-tools-dir> <tools-dest-dir> [release-note]');
  }

  const note = releaseNote || '(no release note provided)';

  // Validate every source file exists before touching the destination.
  for (const rel of [...RELEASE_FILES, LAUNCHER_SOURCE]) {
    const src = path.join(kbToolsDir, rel);
    if (!fs.existsSync(src)) {
      return fail('FILE_NOT_FOUND', src);
    }
  }

  const currentDir = path.join(destRoot, 'canvas-player');
  const output = [];

  // Archive the existing release, if any, as the next canvas-player-vN.
  if (fs.existsSync(currentDir)) {
    const existingVersions = fs.readdirSync(destRoot)
      .map(name => /^canvas-player-v(\d+)$/.exec(name))
      .filter(Boolean)
      .map(m => parseInt(m[1], 10));
    const nextVersion  = existingVersions.length ? Math.max(...existingVersions) + 1 : 1;
    const archivedDir  = path.join(destRoot, `canvas-player-v${nextVersion}`);

    fs.renameSync(currentDir, archivedDir);
    fs.writeFileSync(
      path.join(archivedDir, 'RELEASE-NOTES.md'),
      `# canvas-player-v${nextVersion}\n\nArchived: ${new Date().toISOString().slice(0, 10)}\n\n${note}\n`,
      'utf8'
    );
    output.push(`Archived previous release to ${archivedDir}`);
  }

  // Publish the fresh release.
  fs.mkdirSync(path.join(currentDir, 'lib'), { recursive: true });

  for (const rel of RELEASE_FILES) {
    const src = path.join(kbToolsDir, rel);
    const dst = path.join(currentDir, rel);
    fs.copyFileSync(src, dst);
    output.push(`Copied ${rel}`);
  }

  fs.copyFileSync(path.join(kbToolsDir, LAUNCHER_SOURCE), path.join(currentDir, LAUNCHER_DEST));
  output.push(`Copied ${LAUNCHER_SOURCE} -> ${LAUNCHER_DEST}`);

  output.push(`Published to ${currentDir}`);

  console.log('OK');
  output.forEach(line => console.log(line));
}

main();
