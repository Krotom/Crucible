// Which Java runs the robot simulation. WPILib installs its own JDK (C:\Users\Public\wpilib\2026\jdk on Windows, ~/wpilib/2026/jdk elsewhere), and the robot
// project is built for it, so that one is used when it can be found, ahead of whatever Java is on the PATH. A folder named in crucible.config.json
// ("javaHome") wins over both. Plain Node (no Electron); the file system is passed in so it can be tested.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface JavaChoice {
  /** folder to set JAVA_HOME to, or null to leave Java to the PATH */
  home: string | null
  /** the java executable to run for the version check ("java" when it comes from the PATH) */
  command: string
  /** where the choice came from, for messages */
  source: 'config' | 'wpilib' | 'path'
}

export interface JavaFs {
  exists(p: string): boolean
  list(dir: string): string[]
}

const realFs: JavaFs = {
  exists: (p) => fs.existsSync(p),
  list: (dir) => { try { return fs.readdirSync(dir) } catch { return [] } },
}

const exeName = (platform: string): string => (platform === 'win32' ? 'java.exe' : 'java')

/** The WPILib year a robot project is built for (the GradleRIO plugin version in build.gradle, e.g. "2026.1.1"), or null. */
export function projectWpilibYear(robotDir: string | null, read: (p: string) => string = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }): string | null {
  if (!robotDir) return null
  const text = ['build.gradle', 'build.gradle.kts'].map((n) => read(path.join(robotDir, n))).join('\n')
  const m = /GradleRIO["']?\s*\)?\s*(?:version)?\s*["'](\d{4})\./i.exec(text) ?? /edu\.wpi\.first\.GradleRIO["']\s+version\s+["'](\d{4})\./.exec(text)
  return m ? m[1] : null
}

/** The WPILib install folders to look in, most likely first. */
export function wpilibRoots(platform: string, env: Record<string, string | undefined>, home: string): string[] {
  const sep = platform === 'win32' ? path.win32 : path.posix
  const roots: string[] = []
  if (env.WPILIB_HOME) roots.push(env.WPILIB_HOME)
  if (platform === 'win32') roots.push(sep.join(env.PUBLIC || 'C:\\Users\\Public', 'wpilib'))
  roots.push(sep.join(home, 'wpilib'))
  return [...new Set(roots)]
}

/** WPILib's JDK folder: the project's year when it is installed, else the newest year. Null when there is none. */
export function findWpilibJdk(opts: { year?: string | null; platform?: string; env?: Record<string, string | undefined>; home?: string; fs?: JavaFs } = {}): string | null {
  const platform = opts.platform ?? process.platform
  const f = opts.fs ?? realFs
  const sep = platform === 'win32' ? path.win32 : path.posix
  for (const root of wpilibRoots(platform, opts.env ?? process.env, opts.home ?? os.homedir())) {
    const years = f.list(root).filter((y) => /^\d{4}$/.test(y)).sort((a, b) => Number(b) - Number(a))
    const ordered = opts.year && years.includes(opts.year) ? [opts.year, ...years.filter((y) => y !== opts.year)] : years
    for (const y of ordered) {
      const jdk = sep.join(root, y, 'jdk')
      if (f.exists(sep.join(jdk, 'bin', exeName(platform)))) return jdk
    }
  }
  return null
}

/** The Java to use: the configured folder, else WPILib's JDK, else the PATH. */
export function chooseJava(cfg: Record<string, unknown>, robotDir: string | null, opts: { platform?: string; env?: Record<string, string | undefined>; home?: string; fs?: JavaFs; read?: (p: string) => string } = {}): JavaChoice {
  const platform = opts.platform ?? process.platform
  const f = opts.fs ?? realFs
  const sep = platform === 'win32' ? path.win32 : path.posix
  const configured = typeof cfg.javaHome === 'string' && cfg.javaHome.trim() !== '' ? cfg.javaHome.trim() : null
  if (configured && f.exists(sep.join(configured, 'bin', exeName(platform)))) return { home: configured, command: sep.join(configured, 'bin', exeName(platform)), source: 'config' }
  const wp = findWpilibJdk({ year: projectWpilibYear(robotDir, opts.read), platform, env: opts.env, home: opts.home, fs: f })
  if (wp) return { home: wp, command: sep.join(wp, 'bin', exeName(platform)), source: 'wpilib' }
  return { home: null, command: 'java', source: 'path' }
}
