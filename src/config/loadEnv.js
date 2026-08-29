const fs = require('fs');
const path = require('path');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex < 0) continue;

    const key = line.slice(0, eqIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;

    const value = line.slice(eqIndex + 1).trim();
    process.env[key] = value;
  }
}

function loadLocalEnv(repoRoot) {
  const envPath = path.join(repoRoot, '.env');
  loadEnvFile(envPath);
}

module.exports = {
  loadLocalEnv,
};
