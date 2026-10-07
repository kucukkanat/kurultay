#!/usr/bin/env bash
# Assemble the installable package published on the `dist` branch.
# One folder serves: npx (bin), pi (pi manifest + extension + skill).
set -euo pipefail
OUT="${1:-out}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
rm -rf "$OUT" && mkdir -p "$OUT/dist" "$OUT/pi" "$OUT/skills/kurultay"
cp "$ROOT/packages/mcp/dist/cli.js" "$OUT/dist/cli.js"
# the sandbox's helper programs (Linux seccomp filter, Windows srt-win.exe) must sit beside cli.js; see docs/sandbox.md
if [ ! -d "$ROOT/packages/mcp/dist/vendor" ]; then echo "packages/mcp/dist/vendor is missing: run the mcp build first" >&2; exit 1; fi
cp -R "$ROOT/packages/mcp/dist/vendor" "$OUT/dist/vendor"
cp "$ROOT/packages/mcp/pi/extension.ts" "$OUT/pi/extension.ts"
cp "$ROOT/plugins/kurultay/skills/kurultay/SKILL.md" "$OUT/skills/kurultay/SKILL.md"
cp "$ROOT/packages/mcp/README.md" "$ROOT/LICENSE" "$OUT/"
node -e '
  const p = require(process.argv[1]);
  const out = {
    name: p.name, version: p.version, description: p.description, type: "module", license: p.license,
    homepage: p.homepage, repository: p.repository, keywords: [...p.keywords, "pi-package"],
    bin: p.bin, files: ["dist", "pi", "skills"], engines: p.engines,
    pi: { extensions: ["./pi/extension.ts"], skills: ["./skills"] }
  };
  require("fs").writeFileSync(process.argv[2] + "/package.json", JSON.stringify(out, null, 2) + "\n");
' "$ROOT/packages/mcp/package.json" "$OUT"
echo "assembled $OUT"
