using System;
using System.Drawing;
using System.Windows.Forms;
// Authored application wallpaper fixture: no audio, disk IO, network, or user data.
static class ApplicationFixture {
  sealed class Surface : Form {
    int tick;
    protected override bool ShowWithoutActivation { get { return true; } }
    public Surface() {
      Text = "Codex Bridge synthetic Application"; ClientSize = new Size(640, 360);
      FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; DoubleBuffered = true;
      var timer = new Timer { Interval = 60 }; timer.Tick += delegate { tick++; Invalidate(); }; timer.Start();
    }
    protected override void OnPaint(PaintEventArgs e) {
      e.Graphics.Clear(Color.FromArgb(40 + tick % 180, 80, 140));
      e.Graphics.FillRectangle(Brushes.White, tick * 5 % 600, 20, 40, 320);
    }
  }
  [STAThread] static void Main(string[] args) {
    var surface=new Surface();if(Array.IndexOf(args,"--offscreen")>=0){surface.ShowInTaskbar=true;surface.StartPosition=FormStartPosition.Manual;surface.Location=new Point(-10000,-10000);}
    Application.Run(surface);
  }
}
