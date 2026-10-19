#requires -Version 5.1
param([string]$OutputDirectory, [switch]$PhysicalDpi, [ValidateSet(0,96,144)][int]$ExpectedDpi = 0, [string]$AssemblyPath, [switch]$VisibleFixture)
$ErrorActionPreference = 'Stop'
if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { throw 'Run this script with powershell.exe -STA -File scripts/manager-ui-smoke.ps1.' }
$previousThreadDpi = [IntPtr]::Zero
if ($PhysicalDpi) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class UiFixtureDpi {
  [DllImport("user32.dll",SetLastError=true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
  $previousThreadDpi = [UiFixtureDpi]::SetThreadDpiAwarenessContext([IntPtr](-4))
  if ($previousThreadDpi -eq [IntPtr]::Zero) { throw 'Physical-DPI test context could not be established.' }
}
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot '.local-evidence' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
[Windows.Forms.Application]::EnableVisualStyles()
[Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)
if ($VisibleFixture) {
  Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class UiFixtureScreen {
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll",SetLastError=true)] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  public static void Capture(IntPtr window, string path) {
    var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    if (previous == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      Rect rect; if (!GetWindowRect(window, out rect)) throw new Win32Exception(Marshal.GetLastWin32Error());
      using (var bitmap = new Bitmap(rect.Right - rect.Left, rect.Bottom - rect.Top)) {
        using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, bitmap.Size);
        bitmap.Save(path, ImageFormat.Png);
      }
    } finally { SetThreadDpiAwarenessContext(previous); }
  }
}
'@
}
if (-not $AssemblyPath) { $AssemblyPath = Join-Path $projectRoot 'build/CodexWallpaperBridge.exe' }
$assemblyPath = [IO.Path]::GetFullPath($AssemblyPath)
if (-not (Test-Path -LiteralPath $assemblyPath)) { throw 'Build CodexWallpaperBridge.exe before running this UI smoke check.' }
$assembly = [Reflection.Assembly]::LoadFrom($assemblyPath)
$formType = $assembly.GetType('CodexWallpaperBridge.SettingsForm', $true)
$fields = [Reflection.BindingFlags]'Instance,Public,NonPublic'
$form = $formType.GetConstructors($fields)[0].Invoke([object[]]@($null))
$serializer = New-Object Web.Script.Serialization.JavaScriptSerializer
$checks = New-Object 'Collections.Generic.List[object]'
$fixtureImage = Join-Path $OutputDirectory 'manager-ui-fixture-cover.png'

function Get-Field([string]$Name) { $formType.GetField($Name, $fields).GetValue($form) }
function Assert-Check([string]$Name, [bool]$Passed, $Detail) {
  $checks.Add([pscustomobject]@{ name = $Name; passed = $Passed; detail = $Detail })
  if (-not $Passed) { throw ('UI check failed: ' + $Name + ' ' + ($Detail | ConvertTo-Json -Compress -Depth 5)) }
}
function Pump-Task($Task) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while (-not $Task.IsCompleted) {
    [Windows.Forms.Application]::DoEvents()
    if ($watch.ElapsedMilliseconds -gt 15000) { throw 'UI fixture rendering timed out.' }
    Start-Sleep -Milliseconds 15
  }
  $null = $Task.GetAwaiter().GetResult()
}
function All-Controls([Windows.Forms.Control]$Control) {
  foreach ($child in $Control.Controls) { $child; All-Controls $child }
}
function Settle-Layout {
  for ($pass = 0; $pass -lt 4; $pass++) {
    $form.PerformLayout()
    foreach ($control in (All-Controls $form)) { $control.PerformLayout() }
    [Windows.Forms.Application]::DoEvents()
  }
}
function Measure-Control([string]$Name, [Windows.Forms.Control]$Control) {
  $ancestors = @()
  $parent = $Control.Parent
  while ($parent) {
    $dimensions = @{ x = $parent.Left; y = $parent.Top; width = $parent.Width; height = $parent.Height; clientWidth = $parent.ClientSize.Width; clientHeight = $parent.ClientSize.Height }
    if ($parent -is [Windows.Forms.TableLayoutPanel]) {
      $dimensions['columnWidths'] = @($parent.GetColumnWidths())
      $dimensions['rowHeights'] = @($parent.GetRowHeights())
      $dimensions['cell'] = @{ column = $parent.GetColumn($Control); row = $parent.GetRow($Control) }
    }
    $ancestors += [pscustomobject]@{ type = $parent.GetType().Name; bounds = $dimensions; visible = $parent.Visible }
    $parent = $parent.Parent
  }
  $textWidth = [Windows.Forms.TextRenderer]::MeasureText($Control.Text, $Control.Font, [Drawing.Size]::Empty, [Windows.Forms.TextFormatFlags]'SingleLine,NoPadding').Width
  [pscustomobject]@{ name = $Name; type = $Control.GetType().Name; visible = $Control.Visible; handleCreated = $Control.IsHandleCreated; text = $Control.Text; x = $Control.Left; y = $Control.Top; width = $Control.Width; height = $Control.Height; preferredWidth = $Control.PreferredSize.Width; preferredHeight = $Control.PreferredSize.Height; singleLineTextWidth = $textWidth; ancestors = $ancestors }
}
function Capture-Tab([string]$Name, [int]$Index, [string]$Suffix = '') {
  $tabs.SelectedIndex = $Index
  Settle-Layout
  if ($Index -eq 0) { Assert-Check ($Name + $Suffix + ': library keeps useful height') ((Get-Field 'library').ClientSize.Height -ge 220) (Get-Field 'library').ClientSize.Height }
  $buttons = @((All-Controls $tabs.SelectedTab) | Where-Object { $_ -is [Windows.Forms.Button] })
  $rectangles = @()
  foreach ($button in $buttons) {
    # The property panel intentionally scrolls. Fixed actions must remain inside the client viewport.
    $ancestor = $button.Parent; $scrolling = $false
    while ($ancestor -and $ancestor -ne $tabs.SelectedTab) { if ($ancestor -eq (Get-Field 'selectionPanel')) { $scrolling = $true; break }; $ancestor = $ancestor.Parent }
    if ($scrolling) { continue }
    $originX = $button.Left; $originY = $button.Top; $ancestor = $button.Parent
    while ($ancestor -and $ancestor -ne $form) { $originX += $ancestor.Left; $originY += $ancestor.Top; $ancestor = $ancestor.Parent }
    $bounds = New-Object Drawing.Rectangle($originX, $originY, $button.ClientSize.Width, $button.ClientSize.Height)
    $rectangles += [pscustomobject]@{ text = $button.Text; x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height }
    Assert-Check ($Name + $Suffix + ': action visible: ' + $button.Text) ($form.ClientRectangle.Contains($bounds) -and $bounds.Width -gt 0 -and $bounds.Height -gt 0) $rectangles[-1]
  }
  $bitmap = New-Object Drawing.Bitmap($form.Width, $form.Height)
  try {
    $form.DrawToBitmap($bitmap, (New-Object Drawing.Rectangle(0, 0, $bitmap.Width, $bitmap.Height)))
    $bitmap.Save((Join-Path $OutputDirectory ('manager-ui-' + $Name + $Suffix + '.png')), [Drawing.Imaging.ImageFormat]::Png)
  } finally { $bitmap.Dispose() }
  if ($VisibleFixture) {
    [UiFixtureScreen]::Capture($form.Handle, (Join-Path $OutputDirectory ('manager-ui-' + $Name + $Suffix + '-screen.png')))
  }
  $displayGeometry = @()
  if ($Index -eq 1) {
    foreach ($field in @('mode','fps')) { $displayGeometry += Measure-Control $field (Get-Field $field) }
    foreach ($field in @('opacity','blur','brightness','contrast')) { $displayGeometry += Measure-Control ($field + '-value') (Get-Field $field).Parent.Controls[1] }
    foreach ($measurement in $displayGeometry) {
      Assert-Check ($Name + $Suffix + ': readable display control: ' + $measurement.name) ($measurement.visible -and $measurement.handleCreated -and $measurement.width -ge $measurement.singleLineTextWidth -and $measurement.height -gt 0) $measurement
    }
  }
  [pscustomobject]@{ tab = $Name; suffix = $Suffix; clientWidth = $form.ClientSize.Width; clientHeight = $form.ClientSize.Height; buttons = $rectangles; displayGeometry = $displayGeometry }
}

try {
  # This fixture is generated locally and never scans, launches, or alters a real wallpaper or client.
  $cover = New-Object Drawing.Bitmap(640, 360)
  $graphics = [Drawing.Graphics]::FromImage($cover)
  $brush = New-Object Drawing.Drawing2D.LinearGradientBrush((New-Object Drawing.Point(0, 0)), (New-Object Drawing.Point(640, 360)), [Drawing.Color]::FromArgb(33, 61, 103), [Drawing.Color]::FromArgb(128, 179, 189))
  try {
    $graphics.FillRectangle($brush, 0, 0, 640, 360)
    $graphics.FillPolygon([Drawing.Brushes]::MidnightBlue, [Drawing.Point[]]@((New-Object Drawing.Point(0, 310)), (New-Object Drawing.Point(220, 110)), (New-Object Drawing.Point(470, 360)), (New-Object Drawing.Point(0, 360))))
    $graphics.FillPolygon([Drawing.Brushes]::SlateGray, [Drawing.Point[]]@((New-Object Drawing.Point(250, 360)), (New-Object Drawing.Point(465, 145)), (New-Object Drawing.Point(640, 290)), (New-Object Drawing.Point(640, 360))))
    $cover.Save($fixtureImage, [Drawing.Imaging.ImageFormat]::Png)
  } finally { $brush.Dispose(); $graphics.Dispose(); $cover.Dispose() }
  $row = $serializer.DeserializeObject(@'
{"state":"Active","version":"1.0.0-ui-fixture","code":"","windowCount":2,"policy":{"fps":60},"source":{"type":"video","id":"fixture-video"},"updates":{"status":"NotConfigured"},"apps":{},"metrics":{"cpu":2.8},"adapter":{},"retry":{},"settings":{"enabled":true,"startup":false,"autoAdjust":true,"debug":false,"allowCandidateAdapter":false,"experimentalWindowFrames":false,"performance":"balanced","fpsLimit":60,"selectedWallpaper":"C:\\Wallpaper Library\\fixture-video\\project.json","wallpaperProfiles":{"fixture-video":{"display":{"zoom":1.15,"positionX":0.46,"positionY":0.57},"properties":{"speed":1.25,"particles":true,"quality":"high","accent":"0.2 0.6 0.9","caption":"自有测试窗口"}}},"effects":{"opacity":0.6,"blur":0,"brightness":1,"contrast":1}}}
'@)
  $baseItem = $serializer.DeserializeObject(@'
{"id":"fixture-video","title":"晨间山脊 · 布局测试","type":"video","project":"C:\\Wallpaper Library\\fixture-video\\project.json","backend":"chromium-muted-video","nativePlayback":{"code":"NATIVE_INDEPENDENT_MUTE_UNAVAILABLE"},"properties":[{"key":"speed","label":"动画速度","type":"slider","value":1,"min":0.1,"max":3,"step":0.05,"precision":2},{"key":"particles","label":"粒子效果","type":"bool","value":true},{"key":"quality","label":"画质","type":"combo","value":"high","options":[{"label":"标准","value":"normal"},{"label":"高","value":"high"}]},{"key":"accent","label":"主题颜色","type":"color","value":"0.2 0.6 0.9"},{"key":"caption","label":"文字","type":"textinput","value":"布局测试"}]}
'@)
  $baseItem['preview'] = $fixtureImage
  $baseItem['properties'] += @(
    $serializer.DeserializeObject('{"key":"backgroundfile","label":"自选图片","type":"file","filetype":"image","value":"C:/authored-default.png"}'),
    $serializer.DeserializeObject('{"key":"backgroundfolder","label":"自选文件夹","type":"directory","mode":"fetchall","value":"C:/authored-folder"}')
  )
  $row['version'] = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json).version + '-ui-fixture'
  $row['settings']['effects']['opacity'] = 1
  $mockItems = New-Object 'Collections.Generic.List[Collections.Generic.Dictionary[string,object]]'
  $mockItems.Add($baseItem)
  for ($index = 1; $index -lt 124; $index++) {
    $item = New-Object 'Collections.Generic.Dictionary[string,object]' -ArgumentList (,$baseItem)
    $item['id'] = 'fixture-' + $index; $item['title'] = '静态封面 ' + $index; $item['type'] = @('video', 'web', 'scene', 'application')[$index % 4]
    $item['project'] = 'C:\Wallpaper Library\fixture-' + $index + '\project.json'
    $item['backend'] = if ($item['type'] -eq 'video') { 'chromium-muted-video' } elseif ($item['type'] -eq 'web') { 'isolated-muted-web' } else { 'unavailable' }
    $item['nativePlayback'] = $serializer.DeserializeObject('{"state":"unavailable","safe":false,"code":"ISOLATED_ENGINE_VERSION_UNVERIFIED"}')
    if ($index -eq 1 -or $index -eq 2) { $item['backend'] = 'wallpaper-engine-isolated'; $item['nativePlayback'] = $serializer.DeserializeObject('{"state":"verified","safe":true,"code":"ISOLATED_ENGINE_OUTPUT_DISABLED"}') }
    if ($index -eq 3) { $item['backend'] = 'independent-owned-application'; $item['nativePlayback'] = $serializer.DeserializeObject('{"state":"verified","safe":true,"code":"APPLICATION_UNITY_AUDIO_DISABLED_PRESTART"}') }
    if ($index -eq 4) { $item['type'] = 'web'; $item['backend'] = 'isolated-muted-web' }
    $mockItems.Add($item)
  }
  $form.StartPosition = [Windows.Forms.FormStartPosition]::Manual; $form.Location = if ($VisibleFixture) { New-Object Drawing.Point(12, 12) } else { New-Object Drawing.Point(-12000, -12000) }; $form.ShowInTaskbar = $false
  $form.Icon = [Drawing.Icon]::ExtractAssociatedIcon($assemblyPath)
  $brand = All-Controls $form | Where-Object Name -EQ 'BrandIcon' | Select-Object -First 1
  if ($brand) { $brand.Image.Dispose(); $brand.Image = $form.Icon.ToBitmap() }
  $form.CreateControl(); $null = $form.Handle; $form.Show()
  $uiSynchronization = New-Object Windows.Forms.WindowsFormsSynchronizationContext
  [Threading.SynchronizationContext]::SetSynchronizationContext($uiSynchronization)
  $library = Get-Field 'library'; $null = $library.Handle
  $formType.GetMethod('SetStatus').Invoke($form, [object[]]@($row)) | Out-Null
  $formType.GetField('libraryItems', $fields).SetValue($form, $mockItems.ToArray())
  $task = $formType.GetMethod('RenderLibraryPage', $fields).Invoke($form, [object[]]@(0, 0))
  Pump-Task $task
  $formType.GetMethod('SetStatus').Invoke($form, [object[]]@($row)) | Out-Null
  $library.Items[0].Selected = $true
  $formType.GetMethod('ShowSelection', $fields).Invoke($form, @()) | Out-Null
  $tabs = (All-Controls $form | Where-Object { $_ -is [Windows.Forms.TabControl] } | Select-Object -First 1)
  Assert-Check 'Three management tabs' ($tabs.TabCount -eq 3) $tabs.TabCount
  $navigation = Get-Field 'navigation'
  Assert-Check 'Three sidebar navigation buttons' ($navigation.Count -eq 3) $navigation.Count
  $navigation[1].PerformClick(); Assert-Check 'Sidebar opens display settings' ($tabs.SelectedIndex -eq 1) $tabs.SelectedIndex
  $navigation[0].PerformClick(); Assert-Check 'Sidebar returns to library' ($tabs.SelectedIndex -eq 0) $tabs.SelectedIndex
  Assert-Check 'FPS choices' ((Get-Field 'fps').Items.Count -eq 4) @((Get-Field 'fps').Items)
  Assert-Check 'Desktop monitor selector removed' ($null -eq $formType.GetField('monitor', $fields)) $null
  Assert-Check 'Paged static covers' ($library.Items.Count -eq 120 -and (Get-Field 'covers').Images.Count -eq 120) $library.Items.Count
  Assert-Check 'Selected composition restored' ((Get-Field 'zoom').Value -eq 1.15 -and (Get-Field 'positionX').Value -eq 46 -and (Get-Field 'positionY').Value -eq 57) @{ zoom = (Get-Field 'zoom').Value; positionX = (Get-Field 'positionX').Value; positionY = (Get-Field 'positionY').Value }
  Assert-Check 'Five metadata property controls' ((Get-Field 'propertyEditors').Count -eq 5) (Get-Field 'propertyEditors').Count
  $fileEditor = All-Controls (Get-Field 'selectionPanel') | Where-Object Name -EQ 'property-path-backgroundfile' | Select-Object -First 1
  $folderEditor = All-Controls (Get-Field 'selectionPanel') | Where-Object Name -EQ 'property-path-backgroundfolder' | Select-Object -First 1
  Assert-Check 'File and directory editors are present' ($null -ne $fileEditor -and $null -ne $folderEditor) $null
  Assert-Check 'Untouched authored paths do not grant saved access' (-not (Get-Field 'propertyEditors').ContainsKey('backgroundfile') -and -not (Get-Field 'propertyEditors').ContainsKey('backgroundfolder')) $null
  Assert-Check 'Path values are read-only and chooser labels match property type' ($fileEditor.PathBox.ReadOnly -and $folderEditor.PathBox.ReadOnly -and $fileEditor.BrowseButton.Text -eq '选择文件' -and $folderEditor.BrowseButton.Text -eq '选择文件夹') $null
  $fileEditor.AcceptSelection($fixtureImage)
  $folderEditor.AcceptSelection($OutputDirectory)
  Assert-Check 'Explicit file and directory selections enter the save payload' ((Get-Field 'propertyEditors')['backgroundfile'].Invoke() -eq $fixtureImage -and (Get-Field 'propertyEditors')['backgroundfolder'].Invoke() -eq $OutputDirectory) $null
  $fileEditor.AcceptSelection('')
  Assert-Check 'Clearing a file saves an explicit empty path' ((Get-Field 'propertyEditors')['backgroundfile'].Invoke() -eq '' -and -not $fileEditor.ClearButton.Enabled) $null
  Assert-Check 'Muted video applies without unsafe native preview' ((Get-Field 'selectWallpaper').Enabled -and -not (Get-Field 'previewWallpaper').Enabled) $null
  Assert-Check 'Wallpaper title replaces raw path' ((Get-Field 'currentWallpaper').Text -like '*晨间山脊*' -and (Get-Field 'currentWallpaper').Text -notlike '*C:\*') (Get-Field 'currentWallpaper').Text
  (Get-Field 'opacity').Value = 42
  Assert-Check 'Slider numeric value updates immediately' (@(All-Controls $form | Where-Object { $_ -is [Windows.Forms.Label] -and $_.Text -eq '42%' }).Count -eq 1) $null
  (Get-Field 'opacity').Value = 100
  $captures = @((Capture-Tab 'library' 0), (Capture-Tab 'settings' 1), (Capture-Tab 'status' 2))
  $tabs.SelectedIndex = 0
  $selectionPanel = Get-Field 'selectionPanel'
  $selectionPanel.ScrollControlIntoView($folderEditor)
  Settle-Layout
  foreach ($editor in @($fileEditor, $folderEditor)) {
    $editorBounds = $selectionPanel.RectangleToClient($editor.RectangleToScreen($editor.ClientRectangle))
    Assert-Check ('Scrolled path editor is visible: ' + $editor.Name) ($selectionPanel.ClientRectangle.Contains($editorBounds)) @{ x = $editorBounds.X; y = $editorBounds.Y; width = $editorBounds.Width; height = $editorBounds.Height }
    foreach ($child in @($editor.PathBox, $editor.BrowseButton, $editor.ClearButton)) {
      $childBounds = $editor.RectangleToClient($child.RectangleToScreen($child.ClientRectangle))
      Assert-Check ('Path editor child fits: ' + $editor.Name + ' ' + $child.GetType().Name + ' ' + $child.Text) ($editor.ClientRectangle.Contains($childBounds) -and $childBounds.Width -gt 0 -and $childBounds.Height -gt 0) @{ x = $childBounds.X; y = $childBounds.Y; width = $childBounds.Width; height = $childBounds.Height }
    }
  }
  $captures += Capture-Tab 'path-properties' 0
  $selectionPanel.AutoScrollPosition = [Drawing.Point]::Empty
  $normalSize = $form.Size
  $form.Size = $form.MinimumSize
  $captures += Capture-Tab 'library' 0 '-minimum'
  $captures += Capture-Tab 'settings' 1 '-minimum'
  (Get-Field 'fps').Parent.ScrollControlIntoView((Get-Field 'fps'))
  Settle-Layout
  foreach ($field in @('mode','fps')) {
    $control = Get-Field $field
    $bounds = $control.Parent.RectangleToClient($control.RectangleToScreen($control.ClientRectangle))
    Assert-Check ('Minimum-size performance choice is fully visible after scrolling: ' + $field) ($control.Parent.ClientRectangle.Contains($bounds) -and $bounds.Width -gt 0) @{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height }
  }
  $captures += Capture-Tab 'performance' 1 '-minimum'
  $captures += Capture-Tab 'status' 2 '-minimum'
  $form.Size = $normalSize
  $library.Items[0].Selected = $false; $library.Items[2].Selected = $true
  $formType.GetMethod('ShowSelection', $fields).Invoke($form, @()) | Out-Null
  $nativeLabels = @((All-Controls (Get-Field 'selectionPanel')) | Where-Object { $_ -is [Windows.Forms.Label] } | ForEach-Object { $_.Text })
  Assert-Check 'Verified isolated scene explains private muted playback' (@($nativeLabels | Where-Object { $_ -like '*独立原生渲染*静音播放*桌面壁纸保持原来的选择与声音设置*' }).Count -eq 1) $nativeLabels
  Assert-Check 'Verified isolated scene enables apply and preview' ((Get-Field 'previewWallpaper').Enabled -and (Get-Field 'selectWallpaper').Enabled) $null
  $captures += Capture-Tab 'native-scene' 0
  $library.Items[2].Selected = $false; $library.Items[1].Selected = $true
  $formType.GetMethod('ShowSelection', $fields).Invoke($form, @()) | Out-Null
  $webLabels = @((All-Controls (Get-Field 'selectionPanel')) | Where-Object { $_ -is [Windows.Forms.Label] } | ForEach-Object { $_.Text })
  Assert-Check 'Verified native Web enables apply and preview' ((Get-Field 'previewWallpaper').Enabled -and (Get-Field 'selectWallpaper').Enabled -and @($webLabels | Where-Object { $_ -like '*独立原生渲染*静音播放*' }).Count -eq 1) $webLabels
  $captures += Capture-Tab 'native-web' 0
  $library.Items[1].Selected = $false; $library.Items[3].Selected = $true
  $formType.GetMethod('ShowSelection', $fields).Invoke($form, @()) | Out-Null
  $applicationLabels = @((All-Controls (Get-Field 'selectionPanel')) | Where-Object { $_ -is [Windows.Forms.Label] } | ForEach-Object { $_.Text })
  Assert-Check 'Reviewed application explains startup mute and preserved originals' (@($applicationLabels | Where-Object { $_ -like '*独立应用壁纸*静音播放*启动前禁用声音*原始素材保持不变*' }).Count -eq 1) $applicationLabels
  Assert-Check 'Reviewed application enables apply and preview' ((Get-Field 'previewWallpaper').Enabled -and (Get-Field 'selectWallpaper').Enabled) $null
  $captures += Capture-Tab 'application' 0
  $library.Items[3].Selected = $false; $library.Items[4].Selected = $true
  $formType.GetMethod('ShowSelection', $fields).Invoke($form, @()) | Out-Null
  $fallbackLabels = @((All-Controls (Get-Field 'selectionPanel')) | Where-Object { $_ -is [Windows.Forms.Label] } | ForEach-Object { $_.Text })
  Assert-Check 'Fallback Web enables apply and keeps native preview unavailable' ((Get-Field 'selectWallpaper').Enabled -and -not (Get-Field 'previewWallpaper').Enabled -and @($fallbackLabels | Where-Object { $_ -like '*兼容网页渲染*' }).Count -eq 1) $fallbackLabels
  $library.Items[4].Selected = $false; $library.Items[2].Selected = $true
  $blockedItem = $library.Items[2].Tag
  $blockedItem['backend'] = 'unavailable'; $blockedItem['nativePlayback'] = $serializer.DeserializeObject('{"safe":false,"code":"ISOLATED_ENGINE_VERSION_UNVERIFIED"}')
  $formType.GetMethod('ShowSelection', $fields).Invoke($form, @()) | Out-Null
  Assert-Check 'Unsupported source cannot apply or open unsafe preview' (-not (Get-Field 'selectWallpaper').Enabled -and -not (Get-Field 'previewWallpaper').Enabled) $null
  $blockedLabels = @((All-Controls (Get-Field 'selectionPanel')) | Where-Object { $_ -is [Windows.Forms.Label] } | ForEach-Object { $_.Text })
  Assert-Check 'Unsupported engine has a version validation explanation' (@($blockedLabels | Where-Object { $_ -like '*版本尚未通过独立原生播放验证*' }).Count -eq 1) $blockedLabels
  $tabs.SelectedIndex = 1; Settle-Layout; (Get-Field 'opacity').Value = 20
  $resetEffects = (All-Controls $tabs.SelectedTab | Where-Object { $_ -is [Windows.Forms.Button] -and $_.Text -eq '重置效果' } | Select-Object -First 1)
  $resetEffects.PerformClick()
  Assert-Check 'Reset keeps original wallpaper brightness' ((Get-Field 'opacity').Value -eq 100 -and (Get-Field 'brightness').Value -eq 100) $null
  $formType.GetField('libraryGeneration', $fields).SetValue($form, 1)
  # PowerShell has no Application.Run loop and DoEvents can restore its host context.
  [Threading.SynchronizationContext]::SetSynchronizationContext($uiSynchronization)
  Pump-Task ($formType.GetMethod('RenderLibraryPage', $fields).Invoke($form, [object[]]@(1, 1)))
  Assert-Check 'Second page releases old covers' ($library.Items.Count -eq 4 -and (Get-Field 'covers').Images.Count -eq 4) @{ items = $library.Items.Count; covers = (Get-Field 'covers').Images.Count }
  # Exercise repeated selection to catch disposed composition controls or stale property editors.
  $library.Items[0].Selected = $true; $formType.GetMethod('ShowSelection', $fields).Invoke($form, @()) | Out-Null
  $library.Items[0].Selected = $false; $library.Items[1].Selected = $true; $formType.GetMethod('ShowSelection', $fields).Invoke($form, @()) | Out-Null
  Assert-Check 'Composition controls survive selection changes' (-not (Get-Field 'zoom').IsDisposed -and -not (Get-Field 'positionX').IsDisposed) $null
  $dpiGraphics = $form.CreateGraphics()
  try { $dpi = @{ x = $dpiGraphics.DpiX; y = $dpiGraphics.DpiY } } finally { $dpiGraphics.Dispose() }
  if ($ExpectedDpi) { Assert-Check 'Requested DPI matches measured form graphics' ([Math]::Abs($dpi.x - $ExpectedDpi) -lt 1 -and [Math]::Abs($dpi.y - $ExpectedDpi) -lt 1) $dpi }
  Assert-Check 'Readable UI font' ($form.Font.SizeInPoints -ge 10) @{ family = $form.Font.FontFamily.Name; points = $form.Font.SizeInPoints; autoScale = $form.AutoScaleMode.ToString(); dpi = $dpi }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $assemblyHash = [BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($assemblyPath))).Replace('-', '') } finally { $hasher.Dispose() }
  $report = [pscustomobject]@{ scope = 'SettingsForm fixture layout and editor behavior only; no API, user-client, playback, or file chooser dialog'; backends = @('chromium-muted-video','wallpaper-engine-isolated','independent-owned-application','isolated-muted-web','unavailable'); expectedDpi = $ExpectedDpi; physicalDpiContext = [bool]$PhysicalDpi; visibleFixture = [bool]$VisibleFixture; assembly = $assemblyPath; assemblySha256 = $assemblyHash; checks = $checks.ToArray(); captures = $captures; dpi = $dpi }
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'manager-ui-layout-report.json') -Encoding UTF8
  Write-Output ('PASS: ' + $checks.Count + ' manager UI checks; screenshots in ' + $OutputDirectory)
} finally {
  if ($form) { $form.AllowClose = $true; $form.Dispose() }
  if ($previousThreadDpi -ne [IntPtr]::Zero) { [void][UiFixtureDpi]::SetThreadDpiAwarenessContext($previousThreadDpi) }
}
