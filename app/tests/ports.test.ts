// The robot's ports (who holds them, stopping an old robot simulation) and the Java choice (WPILib's own JDK), with fake command output and a fake file system.
import { describe, expect, it } from 'vitest'
import { describeOwners, freeRobotPorts, isRobotSim, listeningPorts, parseLsof, parseNetstat, parseTasklistName, portOwners, within, type PortOwner } from '../src/main/ports'
import { chooseJava, findWpilibJdk, projectWpilibYear, type JavaFs } from '../src/main/javahome'
import { preflight, preflightBlocks } from '../src/main/preflight'

// a Turkish Windows: the state word is not "LISTENING"
const NETSTAT = [
  '',
  'Etkin Bağlantılar',
  '',
  '  Proto  Yerel Adres          Yabancı Adres          Durum           PID',
  '  TCP    0.0.0.0:1181           0.0.0.0:0              DİNLENİYOR      8020',
  '  TCP    0.0.0.0:5811           0.0.0.0:0              DİNLENİYOR      8020',
  '  TCP    [::]:5810              [::]:0                 DİNLENİYOR      8020',
  '  TCP    127.0.0.1:5811         127.0.0.1:50321        KURULDU         8020',
  '  TCP    127.0.0.1:50321        127.0.0.1:5811         KURULDU         7000',
  '  TCP    0.0.0.0:1735           0.0.0.0:0              DİNLENİYOR      4',
].join('\n')

describe('port holders', () => {
  it('parseNetstat finds listening sockets on the wanted ports in any language, and ignores connections', () => {
    expect(parseNetstat(NETSTAT, [5811, 5810, 1735])).toEqual([{ port: 5811, pid: 8020 }, { port: 5810, pid: 8020 }, { port: 1735, pid: 4 }])
    expect(parseNetstat(NETSTAT, [9999])).toEqual([])
  })

  it('parseLsof and parseTasklistName', () => {
    expect(parseLsof('p123\ncjava\nn*:5811\nn*:5810\np99\ncnode\nn127.0.0.1:3000', [5811, 5810])).toEqual([{ port: 5811, pid: 123, name: 'java' }, { port: 5810, pid: 123, name: 'java' }])
    expect(parseTasklistName('"java.exe","8020","Console","1","245.000 K"\r\n')).toBe('java.exe')
    expect(parseTasklistName('INFO: No tasks are running')).toBe('')
  })

  it('only Java programs count as a robot simulation', () => {
    expect(isRobotSim('java.exe')).toBe(true)
    expect(isRobotSim('java')).toBe(true)
    expect(isRobotSim('System')).toBe(false)
    expect(isRobotSim('chrome.exe')).toBe(false)
  })

  const fakeWin = (state: { alive: Set<number> }) => async (cmd: string, args: string[]): Promise<string> => {
    if (cmd === 'netstat') return NETSTAT.split('\n').filter((l) => !/\b(8020)\s*$/.test(l) || state.alive.has(8020)).join('\n')
    if (cmd === 'tasklist') { const pid = /PID eq (\d+)/.exec(args.join(' '))?.[1]; return pid === '8020' ? '"java.exe","8020"' : '"System","4"' }
    return ''
  }

  it('portOwners names the holder of each port (Windows)', async () => {
    const owners = await portOwners([5811, 5810, 1735], fakeWin({ alive: new Set([8020]) }), 'win32')
    expect(owners.map((o) => `${o.port}:${o.pid}:${o.name}`)).toEqual(['1735:4:System', '5810:8020:java.exe', '5811:8020:java.exe'])
    expect(describeOwners(owners)).toContain('java.exe (PID 8020) on 5810, 5811')
  })

  it('freeRobotPorts stops the Java holder once, leaves other programs alone, and waits for the ports to be free', async () => {
    const state = { alive: new Set([8020]) }
    const killed: number[] = []
    const r = await freeRobotPorts([5811, 5810, 1735], fakeWin(state), async (pid) => { killed.push(pid); state.alive.delete(pid) }, 'win32')
    expect(killed).toEqual([8020])
    expect(r.stopped.map((o) => o.port).sort()).toEqual([5810, 5811])
    expect(r.skipped.map((o) => o.name)).toEqual(['System'])
    expect(r.still).toEqual([])
  })

  it('reports a holder that does not go away', async () => {
    const state = { alive: new Set([8020]) }
    const r = await freeRobotPorts([5811], fakeWin(state), async () => { /* the kill does nothing */ }, 'win32')
    expect(r.stopped).toHaveLength(1)
    expect(r.still.map((o) => o.pid)).toEqual([8020])
  }, 10_000)
})

describe('pre-flight with the ports', () => {
  const java = async (): Promise<string | null> => 'openjdk version "21"'
  const owner = (name: string): PortOwner[] => [{ port: 5811, pid: 8020, name }]

  it('a Java holder blocks the start and names what to do; other holders too', async () => {
    const dir = process.cwd()
    const sim = (await preflight(dir, false, java, { ports: async () => owner('java.exe') })).find((c) => c.id === 'ports')!
    expect(sim.status).toBe('fail')
    expect(sim.detail).toContain('Stop the old robot')
    const other = (await preflight(dir, false, java, { ports: async () => owner('chrome.exe') })).find((c) => c.id === 'ports')!
    expect(other.detail).toContain('close that program')
    expect(preflightBlocks(await preflight(dir, false, java, { ports: async () => owner('java.exe') }))).toBe(true)
  })

  it('free ports pass, and no look-up means no check', async () => {
    const dir = process.cwd()
    expect((await preflight(dir, false, java, { ports: async () => [] })).find((c) => c.id === 'ports')!.status).toBe('ok')
    expect((await preflight(dir, false, java)).some((c) => c.id === 'ports')).toBe(false)
  })

  it('the Java check says where the Java came from', async () => {
    const c = (await preflight(process.cwd(), false, java, { javaFrom: 'wpilib' })).find((x) => x.id === 'java')!
    expect(c.detail).toContain('WPILib')
  })
})

describe('WPILib\'s own Java', () => {
  const files = (...paths: string[]): JavaFs => {
    const set = new Set(paths)
    return {
      exists: (p) => set.has(p),
      list: (dir) => [...new Set(paths.filter((p) => p.startsWith(dir + '\\') || p.startsWith(dir + '/')).map((p) => p.slice(dir.length + 1).split(/[\\/]/)[0]))],
    }
  }
  const win = files('C:\\Users\\Public\\wpilib\\2025\\jdk\\bin\\java.exe', 'C:\\Users\\Public\\wpilib\\2026\\jdk\\bin\\java.exe', 'C:\\Users\\Public\\wpilib\\2026\\jdk\\lib\\x')

  it('finds the newest year, or the project\'s year when it is installed', () => {
    const env = { PUBLIC: 'C:\\Users\\Public' }
    expect(findWpilibJdk({ platform: 'win32', env, home: 'C:\\Users\\me', fs: win })).toBe('C:\\Users\\Public\\wpilib\\2026\\jdk')
    expect(findWpilibJdk({ platform: 'win32', env, home: 'C:\\Users\\me', fs: win, year: '2025' })).toBe('C:\\Users\\Public\\wpilib\\2025\\jdk')
    expect(findWpilibJdk({ platform: 'win32', env, home: 'C:\\Users\\me', fs: win, year: '2024' })).toBe('C:\\Users\\Public\\wpilib\\2026\\jdk') // not installed: the newest
  })

  it('finds the JDK under the home folder elsewhere, and returns null without one', () => {
    const posix = files('/home/me/wpilib/2026/jdk/bin/java')
    expect(findWpilibJdk({ platform: 'linux', env: {}, home: '/home/me', fs: posix })).toBe('/home/me/wpilib/2026/jdk')
    expect(findWpilibJdk({ platform: 'linux', env: {}, home: '/home/other', fs: posix })).toBeNull()
    expect(findWpilibJdk({ platform: 'win32', env: { PUBLIC: 'C:\\Users\\Public' }, home: 'C:\\Users\\me', fs: files() })).toBeNull()
  })

  it('reads the WPILib year from build.gradle', () => {
    expect(projectWpilibYear('/p', () => 'plugins {\n  id "edu.wpi.first.GradleRIO" version "2026.2.1"\n}')).toBe('2026')
    expect(projectWpilibYear('/p', () => 'nothing here')).toBeNull()
    expect(projectWpilibYear(null)).toBeNull()
  })

  it('chooses the configured folder, then WPILib\'s JDK, then the PATH', () => {
    const env = { PUBLIC: 'C:\\Users\\Public' }
    const base = { platform: 'win32', env, home: 'C:\\Users\\me', read: () => '' }
    const withCfg = files('D:\\jdk\\bin\\java.exe', 'C:\\Users\\Public\\wpilib\\2026\\jdk\\bin\\java.exe')
    expect(chooseJava({ javaHome: 'D:\\jdk' }, null, { ...base, fs: withCfg })).toEqual({ home: 'D:\\jdk', command: 'D:\\jdk\\bin\\java.exe', source: 'config' })
    expect(chooseJava({ javaHome: 'D:\\missing' }, null, { ...base, fs: win }).source).toBe('wpilib') // a configured folder without a java is not used
    expect(chooseJava({}, null, { ...base, fs: win })).toEqual({ home: 'C:\\Users\\Public\\wpilib\\2026\\jdk', command: 'C:\\Users\\Public\\wpilib\\2026\\jdk\\bin\\java.exe', source: 'wpilib' })
    expect(chooseJava({}, null, { ...base, fs: files() })).toEqual({ home: null, command: 'java', source: 'path' })
  })
})

describe('Linux look-up and the time cap', () => {
  const PROC = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 00000000:16C3 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1111 1 0 100 0 0 10 0',
    '   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2222 1 0 100 0 0 10 0',
    '   2: 0100007F:E2A0 0100007F:16C3 01 00000000:00000000 00:00000000 00000000  1000        0 3333 1 0 100 0 0 10 0',
  ].join('\n')

  it('listeningPorts reads LISTEN sockets only', () => {
    expect(listeningPorts(PROC).sort((a, b) => a - b)).toEqual([0x16c3, 0x1f90]) // 5827 and 8080; the connected one (state 01) is not listening
  })

  it('does not run lsof at all when none of the robot ports is listening', async () => {
    const calls: string[] = []
    const run = async (cmd: string, args: string[]): Promise<string> => { calls.push(`${cmd} ${args.join(' ')}`); return '' }
    expect(await portOwners([5811, 5810, 1735], run, 'linux', () => PROC)).toEqual([])
    expect(calls).toEqual([])
  })

  it('asks lsof only about the busy ports when one is listening', async () => {
    const calls: string[] = []
    const run = async (cmd: string, args: string[]): Promise<string> => { calls.push(`${cmd} ${args.join(' ')}`); return 'p4242\ncjava\nn*:5827' }
    const tcp = PROC.replace('16C3', '16C3') // 0x16C3 = 5827
    const owners = await portOwners([5827, 5811], run, 'linux', () => tcp)
    expect(owners).toEqual([{ port: 5827, pid: 4242, name: 'java' }])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('-iTCP:5827')
    expect(calls[0]).not.toContain('5811')
  })

  it('within gives the fallback when the answer is late or fails', async () => {
    expect(await within(new Promise<number[]>((r) => setTimeout(() => r([1]), 300)), 20, [])).toEqual([])
    expect(await within(Promise.reject(new Error('x')), 100, ['fallback'])).toEqual(['fallback'])
    expect(await within(Promise.resolve(7), 100, 0)).toBe(7)
  })
})
