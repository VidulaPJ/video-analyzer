// =============================================================================
// save_project_path.js -- runs automatically at the start of `npm run build`.
//
// The packaged .exe can't find live_logger.js by looking at "the folder above
// me" (inside the .exe, the app's files live in a bundle, not in this
// project). So before building, we write down where this project folder is,
// in project-path.json, and that file gets built into the .exe.
// If you ever move the project folder, just run `npm run build` again.
// =============================================================================

const fs = require('fs');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
fs.writeFileSync(
  path.join(__dirname, 'project-path.json'),
  JSON.stringify({ projectDir }, null, 2),
  'utf8'
);
console.log(`Saved project folder for the build: ${projectDir}`);
