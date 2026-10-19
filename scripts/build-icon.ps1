$ErrorActionPreference = 'Stop'
$iconRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\assets'))
New-Item -ItemType Directory -Path $iconRoot -Force | Out-Null
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
public static class BridgeIconBuilder {
  static GraphicsPath Round(float x,float y,float w,float h,float r) {
    var p=new GraphicsPath();p.AddArc(x,y,r,r,180,90);p.AddArc(x+w-r,y,r,r,270,90);
    p.AddArc(x+w-r,y+h-r,r,r,0,90);p.AddArc(x,y+h-r,r,r,90,90);p.CloseFigure();return p;
  }
  static byte[] Frame(int size) {
    using(var b=new Bitmap(size,size,PixelFormat.Format32bppArgb))using(var g=Graphics.FromImage(b)) {
      g.SmoothingMode=SmoothingMode.AntiAlias;g.PixelOffsetMode=PixelOffsetMode.HighQuality;g.ScaleTransform(size/256f,size/256f);
      using(var p=Round(8,8,240,240,112))using(var brush=new LinearGradientBrush(new Point(8,8),new Point(248,248),Color.FromArgb(23,54,84),Color.FromArgb(9,20,35)))g.FillPath(brush,p);
      using(var p=Round(44,52,168,152,48))using(var brush=new SolidBrush(Color.FromArgb(17,38,60)))using(var pen=new Pen(Color.FromArgb(121,200,239),9)){g.FillPath(brush,p);g.DrawPath(pen,p);}
      using(var pen=new Pen(Color.FromArgb(121,200,239),7))g.DrawLine(pen,49,85,207,85);
      using(var brush=new SolidBrush(Color.FromArgb(86,239,213)))g.FillEllipse(brush,61,65,8,8);
      using(var brush=new SolidBrush(Color.FromArgb(66,149,255)))g.FillEllipse(brush,76,65,8,8);
      using(var p=new GraphicsPath())using(var brush=new LinearGradientBrush(new Point(45,120),new Point(211,170),Color.FromArgb(86,239,213),Color.FromArgb(66,149,255)))using(var pen=new Pen(brush,18)){
        pen.StartCap=pen.EndCap=LineCap.Round;p.AddBezier(47,166,82,166,82,119,119,119);p.AddBezier(119,119,156,119,160,183,209,145);g.DrawPath(pen,p);
      }
      using(var p=new GraphicsPath())using(var pen=new Pen(Color.FromArgb(90,66,149,255),8)){
        pen.StartCap=pen.EndCap=LineCap.Round;p.AddBezier(49,190,81,190,96,163,119,163);p.AddBezier(119,163,142,163,169,207,207,176);g.DrawPath(pen,p);
      }
      using(var m=new MemoryStream()){b.Save(m,ImageFormat.Png);return m.ToArray();}
    }
  }
  public static void Build(string root) {
    int[] sizes={16,24,32,48,64,128,256};var frames=new byte[sizes.Length][];
    for(int i=0;i<sizes.Length;i++)frames[i]=Frame(sizes[i]);
    using(var f=File.Create(Path.Combine(root,"bridge.ico")))using(var w=new BinaryWriter(f)){
      w.Write((ushort)0);w.Write((ushort)1);w.Write((ushort)sizes.Length);int offset=6+16*sizes.Length;
      for(int i=0;i<sizes.Length;i++){w.Write((byte)(sizes[i]==256?0:sizes[i]));w.Write((byte)(sizes[i]==256?0:sizes[i]));w.Write((ushort)0);w.Write((ushort)1);w.Write((ushort)32);w.Write(frames[i].Length);w.Write(offset);offset+=frames[i].Length;}
      foreach(var frame in frames)w.Write(frame);
    }
    File.WriteAllBytes(Path.Combine(root,"bridge.png"),frames[frames.Length-1]);
  }
}
'@
[BridgeIconBuilder]::Build($iconRoot)
Write-Output "Built $iconRoot\bridge.ico"
