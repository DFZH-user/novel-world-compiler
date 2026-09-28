const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// Fail before publishing an artifact if the independent Tavern server is incomplete.
module.exports = async function verifyIntegratedResources(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app', 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const tavern = path.join(resources, 'sillytavern');
  for (const file of ['server.js', 'package.json', 'public/scripts/novel-world.js', 'public/scripts/novel-project.js', 'public/scripts/novel-reading-controls.js', 'public/scripts/novel-world-library.js', 'public/scripts/novel-story.js', 'public/scripts/novel-story-core.js', 'public/scripts/novel-story-gate.js', 'public/scripts/novel-story-request.js', 'public/scripts/novel-story-assets.js', 'public/css/novel-world.css', 'public/novel-world-effects.js']) {
    if (!fs.existsSync(path.join(tavern, file))) throw new Error('Incomplete integrated runtime: ' + file);
  }
  const runtimeRequire = createRequire(path.join(tavern, 'package.json'));
  for (const dependency of ['express', 'yaml', 'yargs', 'webpack']) {
    const resolved = runtimeRequire.resolve(dependency);
    if (!resolved.startsWith(tavern + path.sep)) throw new Error('Runtime dependency resolves outside the package: ' + dependency);
  }
};
