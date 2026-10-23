// Extends app.json with values that must not live in git. GOOGLE_MAPS_API_KEY comes from the build
// machine's environment or from mobile/.env; it ends up in the Android manifest, which is where
// Google Maps reads it. .env is read here directly because not every Expo command (e.g. `expo
// config`, prebuild) loads it before evaluating this file.
const fs = require('fs');
const path = require('path');

function readDotEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

module.exports = ({ config }) => {
  const key = process.env.GOOGLE_MAPS_API_KEY || readDotEnv().GOOGLE_MAPS_API_KEY;
  if (!key) return config;
  return {
    ...config,
    android: {
      ...config.android,
      config: { ...(config.android?.config ?? {}), googleMaps: { apiKey: key } },
    },
    // android.config is stripped from the config the app can read at runtime, so expose a plain
    // flag that tells the Maps screen a key is present (the key itself stays out of it).
    extra: { ...(config.extra ?? {}), mapsEnabled: true },
  };
};
