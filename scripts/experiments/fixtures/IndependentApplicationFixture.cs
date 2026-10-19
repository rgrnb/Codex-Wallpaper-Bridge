using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// Authored silent fixture. Only an explicit test-owned report receives mouse
// coordinates; it never reads user files, plays audio or contacts the network.
static class IndependentApplicationFixture {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  sealed class Surface : Form {
    int tick; Point pointer; readonly string report,trace;
    readonly StreamWriter pointerLog,traceLog;
    static StreamWriter OpenLog(string file) {
      return file==null?null:new StreamWriter(new FileStream(file,FileMode.Append,FileAccess.Write,FileShare.ReadWrite|FileShare.Delete),new System.Text.UTF8Encoding(false)){AutoFlush=true};
    }
    [DllImport("user32.dll")] static extern uint InSendMessageEx(IntPtr reserved);
    protected override bool ShowWithoutActivation { get { return true; } }
    public Surface(string output,string diagnostic) {
      report=output;trace=diagnostic;pointerLog=OpenLog(report);traceLog=OpenLog(trace);Text="Codex Bridge independent application fixture";ClientSize=new Size(640,360);
      FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;DoubleBuffered=true;
      // Passive forwarding must never let WinForms focus this offscreen test
      // surface from its default WM_LBUTTONDOWN handler.
      SetStyle(ControlStyles.Selectable,false);
      StartPosition=FormStartPosition.Manual;Location=new Point(-10000,-10000);
      var timer=new Timer{Interval=40};timer.Tick+=delegate{tick++;Invalidate();};timer.Start();
    }
    protected override void WndProc(ref Message message) {
      bool observed=message.Msg==0x0200||message.Msg==0x0201||message.Msg==0x0202;
      if(observed&&traceLog!=null)traceLog.WriteLine("{\"phase\":\"enter\",\"message\":"+message.Msg+",\"sendFlags\":"+InSendMessageEx(IntPtr.Zero)+",\"time\":\""+DateTime.UtcNow.ToString("o")+"\"}");
      base.WndProc(ref message);
      if(observed&&traceLog!=null)traceLog.WriteLine("{\"phase\":\"exit\",\"message\":"+message.Msg+",\"time\":\""+DateTime.UtcNow.ToString("o")+"\"}");
    }
    protected override void DefWndProc(ref Message message) {
      bool observed=message.Msg==0x0200||message.Msg==0x0201||message.Msg==0x0202;
      if(observed&&traceLog!=null)traceLog.WriteLine("{\"phase\":\"default-enter\",\"message\":"+message.Msg+",\"time\":\""+DateTime.UtcNow.ToString("o")+"\"}");
      base.DefWndProc(ref message);
      if(observed&&traceLog!=null)traceLog.WriteLine("{\"phase\":\"default-exit\",\"message\":"+message.Msg+",\"time\":\""+DateTime.UtcNow.ToString("o")+"\"}");
    }
    void Record(string kind,MouseEventArgs input) {
      pointer=input.Location;
      if(traceLog!=null)traceLog.WriteLine("{\"phase\":\"record-enter\",\"kind\":\""+kind+"\",\"time\":\""+DateTime.UtcNow.ToString("o")+"\"}");
      if(pointerLog!=null)pointerLog.WriteLine("{\"type\":\""+kind+"\",\"x\":"+input.X+",\"y\":"+input.Y+",\"width\":"+ClientSize.Width+",\"height\":"+ClientSize.Height+"}");
      if(traceLog!=null)traceLog.WriteLine("{\"phase\":\"record-exit\",\"kind\":\""+kind+"\",\"time\":\""+DateTime.UtcNow.ToString("o")+"\"}");
    }
    protected override void OnMouseMove(MouseEventArgs input) {base.OnMouseMove(input);Record("move",input);}
    protected override void OnMouseDown(MouseEventArgs input) {base.OnMouseDown(input);Record("down",input);}
    protected override void OnMouseUp(MouseEventArgs input) {base.OnMouseUp(input);Record("up",input);}
    protected override void OnMouseClick(MouseEventArgs input) {base.OnMouseClick(input);Record("click",input);}
    protected override void OnPaint(PaintEventArgs input) {
      input.Graphics.Clear(Color.FromArgb(40+tick%180,80,140));
      input.Graphics.FillRectangle(Brushes.White,tick*5%600,20,40,320);
      input.Graphics.FillEllipse(Brushes.Red,pointer.X-8,pointer.Y-8,16,16);
    }
    protected override void Dispose(bool disposing) {
      if(disposing){if(pointerLog!=null)pointerLog.Dispose();if(traceLog!=null)traceLog.Dispose();}
      base.Dispose(disposing);
    }
  }
  [STAThread] static void Main(string[] arguments) {
    int snapshot=Array.IndexOf(arguments,"--snapshot");
    if(snapshot>=0&&snapshot+1<arguments.Length) { Point point;if(!GetCursorPos(out point))throw new InvalidOperationException("Cursor snapshot unavailable");
      File.WriteAllText(arguments[snapshot+1],"{\"foreground\":\""+GetForegroundWindow().ToInt64()+"\",\"x\":"+point.X+",\"y\":"+point.Y+"}");return; }
    int at=Array.IndexOf(arguments,"--report");string report=at>=0&&at+1<arguments.Length?arguments[at+1]:null;
    int traceAt=Array.IndexOf(arguments,"--trace");string trace=traceAt>=0&&traceAt+1<arguments.Length?arguments[traceAt+1]:null;
    Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
    Application.ThreadException+=delegate(object sender,System.Threading.ThreadExceptionEventArgs error){
      if(trace!=null)File.WriteAllText(trace+".failure.txt",error.Exception.ToString());Application.ExitThread();
    };
    Application.Run(new Surface(report,trace));
  }
}
