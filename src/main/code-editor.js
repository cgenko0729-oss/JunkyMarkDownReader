/**
 * 把文档里的 `[L550](Setsuna/SkillData.cs#L550)` 这类链接丢给 Visual Studio 2022，
 * 并跳到指定行。
 *
 * 为什么不是简单的 `devenv /edit <file> /command "Edit.GoTo 547"`
 * -------------------------------------------------------------
 * 实测过了，那条命令**文件会开，但不会跳到那一行**。
 * 原因是 /command 在 /edit 真正把文档加载完之前就执行掉了，
 * 跳转要么落空、要么随后被 VS 恢复的上次光标位置覆盖。
 * （实测：要求跳 547，结果停在 541 —— 上一次关掉时的位置。）
 *
 * 所以改走 EnvDTE：等文档真的开好，再让 IDE 自己 GotoLine。实测稳定命中。
 *
 * 为什么用 PowerShell 而不是 Node 直接调
 *   EnvDTE 是 COM，Node 没有原生 COM 支持。Windows PowerShell 5.1 自带
 *   [Marshal]::GetActiveObject，是这台机器上最省事的 COM 入口。
 *   注意必须是 powershell.exe（5.1），不能用 pwsh —— .NET Core 拿掉了 GetActiveObject。
 *
 * 为什么用 -EncodedCommand 而不是 .ps1 文件
 *   1. 打包进 app.asar 之后，外部进程读不到 asar 里的 .ps1
 *   2. 路径里有空格和 `&`（真实案例：D:\_A QuickStart\Unity & Game\...），
 *      走命令行拼接迟早出事。base64 之后完全没有转义问题。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

/** 常见安装位置，命中就不用跑 vswhere（省掉一次进程启动） */
const WELL_KNOWN = [
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\IDE\\devenv.exe',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\Common7\\IDE\\devenv.exe',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\IDE\\devenv.exe'
];

const VSWHERE = path.join(
  process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  'Microsoft Visual Studio', 'Installer', 'vswhere.exe'
);

/** VS 2022 的 ProgID。换 VS 版本只要改这里（2019 是 16.0） */
const DTE_PROGID = 'VisualStudio.DTE.17.0';

/** 冷启动 VS 最多等多久（秒）*/
const COLD_START_TIMEOUT_SEC = 120;

/** 只解析一次；null 表示解析过但没找到 */
let cachedDevenv;

/** 找出 devenv.exe：先查常见路径，再用 vswhere 兜底（装在非默认盘也能找到） */
function findDevenv() {
  if (cachedDevenv !== undefined) return cachedDevenv;

  for (const p of WELL_KNOWN) {
    if (fs.existsSync(p)) return (cachedDevenv = p);
  }

  try {
    if (fs.existsSync(VSWHERE)) {
      const out = execFileSync(
        VSWHERE,
        ['-latest', '-products', '*', '-property', 'productPath'],
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      if (out && fs.existsSync(out)) return (cachedDevenv = out);
    }
  } catch { /* vswhere 不在或超时，当作没找到 */ }

  return (cachedDevenv = null);
}

/** 转成 PowerShell 单引号字符串字面量（单引号自身要写两遍） */
const psLiteral = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/**
 * 把 VS 主窗口抢到前台。
 *
 * 为什么光靠 $dte.MainWindow.Activate() 不行：
 *   Windows 有前台锁定（foreground lock）—— 非前台进程调 SetForegroundWindow
 *   只会让任务栏图标闪一下，窗口不会真的浮上来。
 *   标准绕法是先 AttachThreadInput 把自己的线程挂到当前前台窗口的线程上，
 *   借它的前台权限调用 SetForegroundWindow，之后再解绑。实测有效。
 *
 * HWND 为什么不用 $dte.MainWindow.HWnd：
 *   PowerShell 的 COM 晚绑定拿这个属性会得到 null，改从进程的
 *   MainWindowHandle 取。多开时用窗口标题（VS 标题以当前文件名开头）挑出正确那个。
 */
const ACTIVATE_SNIPPET = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class JunkyFg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@ -ErrorAction SilentlyContinue

function Bring-VSToFront([string]$leaf) {
  $cands = @(Get-Process devenv -ErrorAction SilentlyContinue |
             Where-Object { $_.MainWindowHandle -ne 0 })
  if ($cands.Count -eq 0) { return }
  $proc = $cands | Where-Object { $_.MainWindowTitle -like "$leaf*" } | Select-Object -First 1
  if (-not $proc) { $proc = $cands | Select-Object -First 1 }

  $h = $proc.MainWindowHandle
  if ([JunkyFg]::IsIconic($h)) { [void][JunkyFg]::ShowWindow($h, 9) }   # SW_RESTORE

  $fg  = [JunkyFg]::GetForegroundWindow()
  $tFg = [JunkyFg]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
  $tMe = [JunkyFg]::GetCurrentThreadId()

  [void][JunkyFg]::AttachThreadInput($tMe, $tFg, $true)
  [void][JunkyFg]::BringWindowToTop($h)
  [void][JunkyFg]::SetForegroundWindow($h)
  [void][JunkyFg]::AttachThreadInput($tMe, $tFg, $false)
}
`;

/** 生成驱动 VS 的 PowerShell 脚本 */
function buildScript(absFile, line, devenv) {
  return `
$ErrorActionPreference = 'Stop'
$file   = ${psLiteral(absFile)}
$line   = ${Number(line) || 0}
$devenv = ${psLiteral(devenv)}
$leaf   = [System.IO.Path]::GetFileName($file)

${ACTIVATE_SNIPPET}

function Get-DTE {
  try { return [System.Runtime.InteropServices.Marshal]::GetActiveObject(${psLiteral(DTE_PROGID)}) }
  catch { return $null }
}

$dte = Get-DTE
if (-not $dte) {
  # 没有在跑的实例 —— 冷启动一个，然后等它把自己注册进 ROT
  Start-Process -FilePath $devenv -ArgumentList '/edit', $file | Out-Null
  for ($i = 0; $i -lt ${COLD_START_TIMEOUT_SEC}; $i++) {
    Start-Sleep -Seconds 1
    $dte = Get-DTE
    if ($dte) { break }
  }
}
if (-not $dte) { exit 2 }

# VS 正忙时 COM 会抛 RPC_E_CALL_REJECTED（比如正在加载解决方案），重试即可
for ($i = 0; $i -lt 60; $i++) {
  try {
    $null = $dte.ItemOperations.OpenFile($file)
    if ($line -gt 0) { $dte.ActiveDocument.Selection.GotoLine($line, $true) }
    $dte.MainWindow.Activate()      # 先让 IDE 自己把该文档设为活动窗口
    Bring-VSToFront $leaf           # 再强行把整个 VS 抢到前台
    exit 0
  } catch {
    Start-Sleep -Milliseconds 500
  }
}
exit 3
`;
}

const EXIT_REASON = {
  2: 'Visual Studio 没能启动起来（等超时了）',
  3: 'Visual Studio 一直处于忙碌状态，跳转被拒绝'
};

/**
 * 在 Visual Studio 2022 里打开文件并跳到指定行。
 * VS 没在跑就冷启动一个（可能要等 20-40 秒）。
 *
 * @param {string} filePath 绝对路径
 * @param {number} [line]   1 起算的行号，省略或 0 则只开文件
 * @returns {Promise<{ok: boolean, reason?: string, line?: number}>}
 */
function openInVisualStudio(filePath, line) {
  return new Promise((resolve) => {
    if (typeof filePath !== 'string' || !filePath) {
      return resolve({ ok: false, reason: '没有给文件路径' });
    }

    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) {
      return resolve({ ok: false, reason: '文件不存在：' + abs });
    }

    const devenv = findDevenv();
    if (!devenv) {
      return resolve({ ok: false, reason: '找不到 Visual Studio 2022（devenv.exe）' });
    }

    const n = Number(line);
    const targetLine = Number.isInteger(n) && n > 0 ? n : 0;
    const encoded = Buffer.from(buildScript(abs, targetLine, devenv), 'utf16le')
      .toString('base64');

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
       '-EncodedCommand', encoded],
      { windowsHide: true, timeout: (COLD_START_TIMEOUT_SEC + 60) * 1000 },
      (err) => {
        if (!err) return resolve({ ok: true, line: targetLine });
        const code = typeof err.code === 'number' ? err.code : null;
        resolve({
          ok: false,
          reason: EXIT_REASON[code] || ('PowerShell 退出码 ' + (code ?? '?'))
        });
      }
    );
  });
}

module.exports = { findDevenv, openInVisualStudio };
