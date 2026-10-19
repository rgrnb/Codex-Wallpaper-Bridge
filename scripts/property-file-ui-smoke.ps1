param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot 'native\BridgeHost.cs')
$begin = $source.IndexOf('    // BEGIN PATH_PROPERTY_EDITOR')
$end = $source.IndexOf('    // END PATH_PROPERTY_EDITOR')
if ($begin -lt 0 -or $end -le $begin) { throw 'Path property editor source was not found.' }
$classSource = $source.Substring($begin, $end - $begin).Replace('sealed class PathPropertyEditor', 'public sealed class PathPropertyEditor')
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition (@'
using System;
using System.IO;
using System.Linq;
using System.Drawing;
using System.Windows.Forms;
public static class PathEditorFixture {
'@ + $classSource + @'
  public static string Run() {
    int changes = 0; string selected = null;
    using (var control = new PathPropertyEditor("Photo",false,"image","C:/authored-default.png",false,delegate(string p){changes++;selected=p;},null,1)) {
      if(changes!=0||control.ExplicitSelection||!control.PathBox.ReadOnly||control.PathBox.Text!="C:/authored-default.png")throw new Exception("Default must remain unselected");
      control.AcceptSelection("D:/explicit-user-photo.png");
      if(changes!=1||!control.ExplicitSelection||selected!="D:/explicit-user-photo.png")throw new Exception("Explicit selection was not committed");
      control.AcceptSelection("bad\npath"); if(changes!=1)throw new Exception("Invalid path was accepted");
      control.AcceptSelection(""); if(changes!=2||selected!=""||control.ClearButton.Enabled)throw new Exception("Clear did not commit an empty selection");
    }
    using(var directory=new PathPropertyEditor("Folder",true,"image","D:/saved-folder",true,null,null,1.5f)) {
      if(!directory.ExplicitSelection||directory.BrowseButton.Text!="\u9009\u62e9\u6587\u4ef6\u5939"||directory.BrowseButton.MinimumSize.Height!=48)throw new Exception("Saved directory/scale was not retained");
    }
    return "passed";
  }
}
'@)
[PathEditorFixture]::Run()
