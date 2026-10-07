// srt's helper programs are files, not code, so `bun build` cannot inline them: copy them beside the bundle
// (dist/vendor/, or the folder given), where src/sandbox/srt.ts `vendored()` and srt itself look. Only what srt runs.
import { chmodSync, cpSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

const pkg = join(dirname(Bun.resolveSync('@anthropic-ai/sandbox-runtime', import.meta.dir)), '..')
const out = process.argv[2] ?? join(import.meta.dir, '..', 'dist', 'vendor')
rmSync(out, { recursive: true, force: true })
for (const rel of ['seccomp/x64/apply-seccomp', 'seccomp/arm64/apply-seccomp', 'srt-win/x64/srt-win.exe', 'srt-win/arm64/srt-win.exe']) {
  cpSync(join(pkg, 'vendor', rel), join(out, rel))
  chmodSync(join(out, rel), 0o755)
}
console.log(`copied srt helpers to ${out}`)
