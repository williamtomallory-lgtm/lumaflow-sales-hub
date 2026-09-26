param([string]$InitialPath = '', [switch]$CompileOnly, [switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace LumaFlow {
  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] internal class FileOpenDialog { }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid id, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint type, out IntPtr name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem other, uint hint, out int order);
  }
  [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint count, IntPtr filters);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem folder);
    void SetFolder(IShellItem folder);
    void GetFolder(out IShellItem folder);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName(out IntPtr name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void GetResult(out IShellItem item);
    void AddPlace(IShellItem item, uint location);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int result);
    void SetClientGuid(ref Guid id);
    void ClearClientData();
    void SetFilter(IntPtr filter);
    void GetResults(out IntPtr items);
    void GetSelectedItems(out IntPtr items);
  }
  public static class WorkspaceFolderPicker {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string name, IntPtr context, ref Guid id, out IShellItem item);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    public static string Select(string initialPath, bool show) {
      var dialog = (IFileOpenDialog)new FileOpenDialog();
      IShellItem result = null;
      try {
        uint options; dialog.GetOptions(out options);
        dialog.SetOptions(options | 0x20 | 0x40 | 0x800 | 0x8);
        dialog.SetTitle("选择 Agent 文件存储工作目录");
        dialog.SetOkButtonLabel("选择文件夹");
        if (System.IO.Directory.Exists(initialPath)) {
          IShellItem folder = null;
          try { var id = typeof(IShellItem).GUID; SHCreateItemFromParsingName(System.IO.Path.GetFullPath(initialPath), IntPtr.Zero, ref id, out folder); dialog.SetFolder(folder); }
          finally { if (folder != null) Marshal.ReleaseComObject(folder); }
        }
        if (!show) return "ready";
        int status = dialog.Show(GetForegroundWindow());
        if (status == unchecked((int)0x800704C7)) return null;
        Marshal.ThrowExceptionForHR(status);
        dialog.GetResult(out result);
        IntPtr name; result.GetDisplayName(0x80058000, out name);
        try { return Marshal.PtrToStringUni(name); } finally { Marshal.FreeCoTaskMem(name); }
      } finally { if (result != null) Marshal.ReleaseComObject(result); Marshal.ReleaseComObject(dialog); }
    }
  }
}
'@
if ($CompileOnly) { Write-Output 'compiled'; exit 0 }
$selected = [LumaFlow.WorkspaceFolderPicker]::Select($InitialPath, (-not $VerifyOnly))
if ($VerifyOnly) { Write-Output $selected; exit 0 }
@{ path = $selected; cancelled = ($null -eq $selected) } | ConvertTo-Json -Compress
