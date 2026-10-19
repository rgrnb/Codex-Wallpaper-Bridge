// Own hidden-window SMTC session for acceptance; it never controls other players
// and never emits audio or shows/activates a window.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Windows.Foundation;
using Windows.Media;
using Windows.Storage.Streams;
internal static class WebMediaFixture {
    [ComImport, Guid("DDB0472D-C911-4A1F-86D9-DC3D71A95F5A"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
    interface ITransportInterop { IntPtr GetForWindow(IntPtr window, ref Guid iid); }
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] static extern int WindowsCreateString(string value, int length, out IntPtr result);
    [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr value);
    [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr name, ref Guid iid, out IntPtr result);
    static T Await<T>(IAsyncOperation<T> operation) {
        var timer = Stopwatch.StartNew();
        while (operation.Status == AsyncStatus.Started) { if (timer.ElapsedMilliseconds > 3000) throw new TimeoutException(); Thread.Sleep(5); }
        return operation.GetResults();
    }
    [STAThread] static void Main() {
        using (var window = new Form()) using (var memory = new InMemoryRandomAccessStream()) {
            window.Text = "CWB authored media acceptance fixture"; window.ShowInTaskbar = false; var handle = window.Handle;
            IntPtr name, factory; string className = "Windows.Media.SystemMediaTransportControls";
            Marshal.ThrowExceptionForHR(WindowsCreateString(className, className.Length, out name));
            var interopId = typeof(ITransportInterop).GUID;
            try { Marshal.ThrowExceptionForHR(RoGetActivationFactory(name, ref interopId, out factory)); } finally { WindowsDeleteString(name); }
            SystemMediaTransportControls controls;
            try {
                var interop = (ITransportInterop)Marshal.GetObjectForIUnknown(factory);
                var controlsId = new Guid("99FA3FF4-1742-42A6-902E-087D41F965EC"); IntPtr pointer = interop.GetForWindow(handle, ref controlsId);
                try { controls = (SystemMediaTransportControls)Marshal.GetObjectForIUnknown(pointer); } finally { Marshal.Release(pointer); }
            } finally { Marshal.Release(factory); }
            try {
                using (var bitmap = new Bitmap(16, 16)) using (var png = new MemoryStream()) {
                    using (var graphics = Graphics.FromImage(bitmap)) graphics.Clear(Color.FromArgb(60, 80, 200));
                    bitmap.Save(png, System.Drawing.Imaging.ImageFormat.Png);
                    using (var writer = new DataWriter(memory.GetOutputStreamAt(0))) { writer.WriteBytes(png.ToArray()); Await(writer.StoreAsync()); writer.DetachStream(); }
                }
                memory.Seek(0); controls.IsEnabled = true; controls.IsPlayEnabled = true; controls.IsPauseEnabled = true;
                var display = controls.DisplayUpdater; display.Type = MediaPlaybackType.Music;
                display.MusicProperties.Title = "CWB authored title"; display.MusicProperties.Artist = "CWB authored artist";
                display.MusicProperties.AlbumTitle = "CWB authored album"; display.Thumbnail = RandomAccessStreamReference.CreateFromStream(memory); display.Update();
                controls.PlaybackStatus = MediaPlaybackStatus.Playing;
                controls.UpdateTimelineProperties(new SystemMediaTransportControlsTimelineProperties {
                    StartTime = TimeSpan.Zero, EndTime = TimeSpan.FromSeconds(120), MinSeekTime = TimeSpan.Zero, MaxSeekTime = TimeSpan.FromSeconds(120), Position = TimeSpan.FromSeconds(12) });
                Console.WriteLine("ready"); Console.Out.Flush(); var timer = Stopwatch.StartNew(); bool changed = false;
                while (timer.ElapsedMilliseconds < 7000) {
                    Application.DoEvents();
                    if (timer.ElapsedMilliseconds > 3000 && !changed) {
                        changed = true; display.MusicProperties.Title = "CWB authored title changed"; display.Update(); controls.PlaybackStatus = MediaPlaybackStatus.Paused;
                    }
                    Thread.Sleep(20);
                }
            } finally { controls.PlaybackStatus = MediaPlaybackStatus.Closed; controls.IsEnabled = false; }
        }
    }
}
