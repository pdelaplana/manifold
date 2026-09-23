$ErrorActionPreference = 'Stop'

# WScript.Shell cannot set a shortcut's AppUserModelID. Without it, the shortcut
# and the running window get separate taskbar buttons.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class Lnk {
  [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellLinkW {
    void GetPath(IntPtr a, int b, IntPtr c, int d);
    void GetIDList(out IntPtr p);
    void SetIDList(IntPtr p);
    void GetDescription(IntPtr a, int b);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetWorkingDirectory(IntPtr a, int b);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetArguments(IntPtr a, int b);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetHotkey(out short h);
    void SetHotkey(short h);
    void GetShowCmd(out int c);
    void SetShowCmd(int c);
    void GetIconLocation(IntPtr a, int b, out int i);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string s, int i);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string s, int r);
    void Resolve(IntPtr h, int f);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string s);
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    void GetCount(out uint c);
    void GetAt(uint i, out PropertyKey k);
    void GetValue(ref PropertyKey k, out PropVariant v);
    void SetValue(ref PropertyKey k, ref PropVariant v);
    void Commit();
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  struct PropertyKey { public Guid fmtid; public uint pid; }

  [StructLayout(LayoutKind.Sequential)]
  struct PropVariant { public ushort vt; ushort r1, r2, r3; public IntPtr p; IntPtr p2; }

  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  class ShellLink {}

  public static void Create(string lnk, string target, string args, string cwd, string aumid, string desc) {
    var link = (IShellLinkW)new ShellLink();
    link.SetPath(target);
    link.SetArguments(args);
    link.SetWorkingDirectory(cwd);
    link.SetIconLocation(target, 0);
    link.SetDescription(desc);

    var store = (IPropertyStore)link;
    var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    var val = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(aumid) };
    store.SetValue(ref key, ref val);
    store.Commit();
    Marshal.FreeCoTaskMem(val.p);

    ((IPersistFile)link).Save(lnk, true);
  }
}
'@

$repo = Split-Path $PSScriptRoot -Parent
$exe = Join-Path $repo 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) { throw "Electron not found at $exe. Run npm install first." }

# Must match the unpackaged ID in src/main.js.
$aumid = 'dev.patrick.manifold.dev'

$lnk = Join-Path $repo 'Manifold (dev).lnk'
[Lnk]::Create($lnk, $exe, "`"$repo`"", $repo, $aumid, 'Manifold (dev, live source)')
"Created $lnk"
