// Read-only Windows integration for isolated Web wallpapers. No playback controls,
// volume changes, microphone access, audio recording, or Wallpaper Engine calls.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Windows.Media.Control;
using Windows.Storage.Streams;

internal static class WebIntegrationHost {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
    static int parentId;
    static long parentTicks;
    static void Emit(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    static bool ParentAlive() {
        try { using (var p = Process.GetProcessById(parentId)) return !p.HasExited && p.StartTime.ToUniversalTime().Ticks == parentTicks; }
        catch { return false; }
    }
    [MTAThread] static int Main(string[] args) {
        try {
            if (args.Length == 1 && args[0] == "--self-test") { Spectrum.SelfTest(); return 0; }
            if (args.Length == 2 && args[0] == "--sessions") { Sessions(args[1]); return 0; }
            if (args.Length != 3 || !int.TryParse(args[1], out parentId) || !long.TryParse(args[2], out parentTicks)) return 2;
            if (parentTicks == 0) using (var parent = Process.GetProcessById(parentId)) parentTicks = parent.StartTime.ToUniversalTime().Ticks;
            if (!ParentAlive()) return 2;
            if (args[0] == "--audio") Audio();
            else if (args[0] == "--media") Media();
            else return 2;
            return 0;
        } catch { Emit(new { error = "WEB_WINDOWS_INTEGRATION_UNAVAILABLE" }); return 1; }
    }
    static T Await<T>(Windows.Foundation.IAsyncOperation<T> operation) {
        try {
            var timer = Stopwatch.StartNew();
            while (operation.Status == Windows.Foundation.AsyncStatus.Started) {
                if (timer.ElapsedMilliseconds > 3000) { operation.Cancel(); throw new TimeoutException(); }
                Thread.Sleep(5);
            }
            if (operation.Status != Windows.Foundation.AsyncStatus.Completed) throw new InvalidOperationException();
            return operation.GetResults();
        } finally { try { operation.Close(); } catch { } }
    }
    static void Media() {
        var manager = Await(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
        Emit(new { ready = "media" });
        while (ParentAlive()) {
            var session = manager.GetCurrentSession();
            if (session == null) Emit(new { media = new { active = false, playback = "stopped", properties = new Dictionary<string, object>() } });
            else {
                var properties = Await(session.TryGetMediaPropertiesAsync());
                var info = session.GetPlaybackInfo();
                var timeline = session.GetTimelineProperties();
                var values = new Dictionary<string, object> {
                    { "title", properties.Title ?? "" }, { "artist", properties.Artist ?? "" },
                    { "albumTitle", properties.AlbumTitle ?? "" }, { "albumArtist", properties.AlbumArtist ?? "" },
                    { "subTitle", properties.Subtitle ?? "" }, { "genres", String.Join(", ", properties.Genres) }
                };
                if (properties.PlaybackType.HasValue) {
                    var type = properties.PlaybackType.Value.ToString().ToLowerInvariant();
                    if (type == "music" || type == "video" || type == "image") values["contentType"] = type;
                }
                string playback = info.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing ? "playing" :
                    info.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused ? "paused" : "stopped";
                double duration = Math.Max(0, (timeline.EndTime - timeline.StartTime).TotalSeconds);
                double position = Math.Max(0, (timeline.Position - timeline.StartTime).TotalSeconds);
                if (playback == "playing") position += Math.Max(0, (DateTimeOffset.UtcNow - timeline.LastUpdatedTime).TotalSeconds);
                if (duration > 0) position = Math.Min(duration, position);
                Emit(new { media = new { active = true, playback = playback, properties = values,
                    timeline = new { position = position, duration = duration }, thumbnail = Thumbnail(properties.Thumbnail) } });
            }
            Thread.Sleep(500);
        }
    }
    static object Thumbnail(IRandomAccessStreamReference reference) {
        if (reference == null) return null;
        try {
            using (var stream = Await(reference.OpenReadAsync())) {
                if (stream.Size == 0 || stream.Size > 2 * 1024 * 1024) return null;
                using (var reader = new DataReader(stream.GetInputStreamAt(0))) {
                    Await(reader.LoadAsync((uint)stream.Size));
                    byte[] data = new byte[stream.Size]; reader.ReadBytes(data);
                    using (var memory = new MemoryStream(data)) using (var image = new Bitmap(memory)) {
                        if ((long)image.Width * image.Height > 16777216) return null;
                        double scale = Math.Min(1, 512.0 / Math.Max(image.Width, image.Height));
                        using (var small = scale == 1 ? new Bitmap(image) : new Bitmap(image, new Size(Math.Max(1, (int)(image.Width * scale)), Math.Max(1, (int)(image.Height * scale))))) {
                            long r = 0, g = 0, b = 0;
                            for (int y = 0; y < small.Height; y++) for (int x = 0; x < small.Width; x++) {
                                var c = small.GetPixel(x, y); r += c.R; g += c.G; b += c.B;
                            }
                            long pixels = (long)small.Width * small.Height;
                            var color = Color.FromArgb((int)(r / pixels), (int)(g / pixels), (int)(b / pixels));
                            string primary = "#" + color.R.ToString("X2") + color.G.ToString("X2") + color.B.ToString("X2");
                            string contrast = (color.R * .2126 + color.G * .7152 + color.B * .0722) > 145 ? "#000000" : "#FFFFFF";
                            using (var png = new MemoryStream()) {
                                small.Save(png, System.Drawing.Imaging.ImageFormat.Png);
                                return new { thumbnail = "data:image/png;base64," + Convert.ToBase64String(png.ToArray()),
                                    primaryColor = primary, secondaryColor = contrast, tertiaryColor = primary,
                                    textColor = contrast, highContrastColor = contrast };
                            }
                        }
                    }
                }
            }
        } catch { return null; }
    }
    static void Check(int result) { if (result < 0) Marshal.ThrowExceptionForHR(result); }
    static void Sessions(string arguments) {
        var requested = new HashSet<uint>();
        foreach (string part in arguments.Split(',')) { uint id; if (!uint.TryParse(part, out id) || id == 0 || requested.Count >= 128) throw new ArgumentException(); requested.Add(id); }
        IMMDeviceEnumerator enumerator = null; IMMDeviceCollection devices = null;
        var rows = new List<object>();
        try {
            enumerator = (IMMDeviceEnumerator)new DeviceEnumerator(); Check(enumerator.EnumAudioEndpoints(0, 1, out devices));
            uint deviceCount; Check(devices.GetCount(out deviceCount));
            for (uint d = 0; d < deviceCount; d++) {
                IMMDevice device = null; object activated = null; IAudioSessionEnumerator sessions = null;
                try {
                    Check(devices.Item(d, out device)); var managerId = typeof(IAudioSessionManager2).GUID;
                    Check(device.Activate(ref managerId, 23, IntPtr.Zero, out activated));
                    var manager = (IAudioSessionManager2)activated; Check(manager.GetSessionEnumerator(out sessions));
                    int count; Check(sessions.GetCount(out count));
                    for (int i = 0; i < count; i++) {
                        IAudioSessionControl2 control = null;
                        try {
                            Check(sessions.GetSession(i, out control)); uint pid; int pidResult = control.GetProcessId(out pid); Check(pidResult);
                            if (!requested.Contains(pid)) continue;
                            int state; bool mute; float volume, peak;
                            Check(control.GetState(out state)); var simple = (ISimpleAudioVolume)control;
                            Check(simple.GetMute(out mute)); Check(simple.GetMasterVolume(out volume));
                            Check(((IAudioMeterInformation)control).GetPeakValue(out peak));
                            rows.Add(new { pid = pid, deviceIndex = d, state = state == 1 ? "active" : state == 2 ? "expired" : "inactive",
                                mute = mute, volume = volume, peak = peak, spansProcesses = pidResult != 0 });
                        } finally { if (control != null) Marshal.ReleaseComObject(control); }
                    }
                } finally {
                    if (sessions != null) Marshal.ReleaseComObject(sessions);
                    if (activated != null) Marshal.ReleaseComObject(activated);
                    if (device != null) Marshal.ReleaseComObject(device);
                }
            }
            Emit(new { queried = true, renderEndpoints = deviceCount, sessions = rows });
        } finally { if (devices != null) Marshal.ReleaseComObject(devices); if (enumerator != null) Marshal.ReleaseComObject(enumerator); }
    }
    static void Audio() {
        IMMDeviceEnumerator enumerator = null; IMMDevice device = null; IAudioClient client = null; IAudioCaptureClient capture = null;
        IntPtr format = IntPtr.Zero;
        try {
            enumerator = (IMMDeviceEnumerator)new DeviceEnumerator();
            Check(enumerator.GetDefaultAudioEndpoint(0, 1, out device)); // eRender, eMultimedia; never an input device.
            Guid clientId = typeof(IAudioClient).GUID; object activated; Check(device.Activate(ref clientId, 23, IntPtr.Zero, out activated)); client = (IAudioClient)activated;
            Check(client.GetMixFormat(out format));
            ushort tag = (ushort)Marshal.ReadInt16(format, 0), channels = (ushort)Marshal.ReadInt16(format, 2);
            int rate = Marshal.ReadInt32(format, 4), align = (ushort)Marshal.ReadInt16(format, 12), bits = (ushort)Marshal.ReadInt16(format, 14);
            if (tag == 0xFFFE) tag = (ushort)Marshal.ReadInt16(format, 24);
            if (channels < 1 || channels > 32 || rate < 8000 || rate > 384000 || align < channels * (bits / 8) ||
                !((tag == 3 && (bits == 32 || bits == 64)) || (tag == 1 && (bits == 16 || bits == 24 || bits == 32)))) throw new NotSupportedException();
            Guid session = Guid.Empty;
            Check(client.Initialize(0, 0x00020000, 1000000, 0, format, ref session)); // shared-mode WASAPI loopback.
            Guid captureId = typeof(IAudioCaptureClient).GUID; Check(client.GetService(ref captureId, out capture)); Check(client.Start());
            var spectrum = new Spectrum(rate); var timer = Stopwatch.StartNew(); long next = 0, framesSeen = 0, lastPacketAt = 0;
            Emit(new { ready = "audio" });
            while (ParentAlive()) {
                uint packet; Check(capture.GetNextPacketSize(out packet));
                while (packet > 0) {
                    IntPtr data; uint frames, flags; ulong position, clock;
                    Check(capture.GetBuffer(out data, out frames, out flags, out position, out clock));
                    try {
                        if (frames > 384000) throw new NotSupportedException();
                        var bytes = new byte[checked((int)frames * align)];
                        bool silent = (flags & 2) != 0;
                        if (!silent) Marshal.Copy(data, bytes, 0, bytes.Length);
                        for (int i = 0; i < frames; i++) {
                            int start = i * align;
                            double left = silent ? 0 : Sample(bytes, start, tag, bits);
                            double right = silent ? 0 : Sample(bytes, start + (channels > 1 ? bits / 8 : 0), tag, bits);
                            spectrum.Push(left, right);
                        }
                        framesSeen += frames; lastPacketAt = timer.ElapsedMilliseconds;
                    } finally { Check(capture.ReleaseBuffer(frames)); }
                    Check(capture.GetNextPacketSize(out packet));
                }
                if (timer.ElapsedMilliseconds >= next) {
                    // An initialized render endpoint with no pending packets is actually silent.
                    // Clear retained peaks after it has remained idle for a full FFT window.
                    if (timer.ElapsedMilliseconds - lastPacketAt > Math.Max(100, 2048000 / rate)) spectrum.Clear();
                    Emit(new { audio = spectrum.Values(), sampleFrames = framesSeen, source = "wasapi-render-loopback" });
                    next = timer.ElapsedMilliseconds + 33;
                }
                Thread.Sleep(4);
            }
        } finally {
            if (client != null) { try { client.Stop(); } catch { } }
            if (format != IntPtr.Zero) Marshal.FreeCoTaskMem(format);
            foreach (object value in new object[] { capture, client, device, enumerator }) if (value != null) Marshal.ReleaseComObject(value);
        }
    }
    static double Sample(byte[] bytes, int at, ushort tag, int bits) {
        double result;
        if (tag == 3) result = bits == 32 ? BitConverter.ToSingle(bytes, at) : BitConverter.ToDouble(bytes, at);
        else if (bits == 16) result = BitConverter.ToInt16(bytes, at) / 32768.0;
        else if (bits == 24) result = ((bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16) << 8 >> 8) / 8388608.0;
        else result = BitConverter.ToInt32(bytes, at) / 2147483648.0;
        return Double.IsNaN(result) || Double.IsInfinity(result) ? 0 : Math.Max(-1, Math.Min(1, result));
    }
    internal sealed class Spectrum {
        const int Count = 2048; readonly double[][] samples = { new double[Count], new double[Count] }; readonly int rate; int at;
        public Spectrum(int sampleRate) { rate = sampleRate; }
        public void Push(double left, double right) { samples[0][at] = left; samples[1][at] = right; at = (at + 1) % Count; }
        public void Clear() { Array.Clear(samples[0], 0, Count); Array.Clear(samples[1], 0, Count); }
        public double[] Values() {
            var output = new double[128];
            for (int channel = 0; channel < 2; channel++) {
                var real = new double[Count]; var imaginary = new double[Count];
                for (int i = 0; i < Count; i++) real[i] = samples[channel][(at + i) % Count] * (.5 - .5 * Math.Cos(2 * Math.PI * i / (Count - 1)));
                for (int i = 1, j = 0; i < Count; i++) {
                    int bit = Count >> 1; for (; (j & bit) != 0; bit >>= 1) j ^= bit; j ^= bit;
                    if (i < j) { double tmp = real[i]; real[i] = real[j]; real[j] = tmp; }
                }
                for (int len = 2; len <= Count; len <<= 1) {
                    double angle = -2 * Math.PI / len;
                    for (int i = 0; i < Count; i += len) {
                        double wr = 1, wi = 0, cr = Math.Cos(angle), ci = Math.Sin(angle);
                        for (int j = 0; j < len / 2; j++) {
                            int a = i + j, b = a + len / 2; double tr = wr * real[b] - wi * imaginary[b], ti = wr * imaginary[b] + wi * real[b];
                            real[b] = real[a] - tr; imaginary[b] = imaginary[a] - ti; real[a] += tr; imaginary[a] += ti;
                            double nextR = wr * cr - wi * ci; wi = wr * ci + wi * cr; wr = nextR;
                        }
                    }
                }
                for (int band = 0; band < 64; band++) {
                    double low = 20 * Math.Pow(1000, band / 64.0), high = 20 * Math.Pow(1000, (band + 1) / 64.0);
                    int from = Math.Max(1, (int)Math.Floor(low * Count / rate)), to = Math.Min(Count / 2 - 1, (int)Math.Ceiling(high * Count / rate));
                    double peak = 0; for (int bin = from; bin <= to; bin++) peak = Math.Max(peak, Math.Sqrt(real[bin] * real[bin] + imaginary[bin] * imaginary[bin]) * 4 / Count);
                    output[channel * 64 + band] = Math.Min(1, peak);
                }
            }
            return output;
        }
        public static void SelfTest() {
            var spectrum = new Spectrum(48000);
            for (int i = 0; i < Count; i++) spectrum.Push(.5 * Math.Sin(2 * Math.PI * 440 * i / 48000), .25 * Math.Sin(2 * Math.PI * 4000 * i / 48000));
            var values = spectrum.Values(); int left = 0, right = 64;
            for (int i = 0; i < 64; i++) { if (values[i] > values[left]) left = i; if (values[64 + i] > values[right]) right = 64 + i; }
            if (left < 25 || left > 31 || right < 110 || right > 115 || values[left] < .4 || values[right] < .2) throw new Exception("Spectrum self test failed");
            Emit(new { result = "passed", bins = 128, leftPeak = left, rightPeak = right - 64, productionAudio = "WASAPI render endpoint only" });
        }
    }
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class DeviceEnumerator { }
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IMMDeviceCollection collection);
        [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
    }
    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceCollection {
        [PreserveSig] int GetCount(out uint count); [PreserveSig] int Item(uint at, out IMMDevice device);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDevice {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr activation, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    }
    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioClient {
        [PreserveSig] int Initialize(int mode, uint flags, long duration, long periodicity, IntPtr format, ref Guid session);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int mode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long normal, out long minimum);
        [PreserveSig] int Start(); [PreserveSig] int Stop(); [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, out IAudioCaptureClient service);
    }
    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioCaptureClient {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong position, out ulong clock);
        [PreserveSig] int ReleaseBuffer(uint frames); [PreserveSig] int GetNextPacketSize(out uint frames);
    }
    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioSessionManager2 {
        [PreserveSig] int GetAudioSessionControl(IntPtr session, uint flags, out IntPtr control);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr session, uint flags, out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    }
    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioSessionEnumerator {
        [PreserveSig] int GetCount(out int count); [PreserveSig] int GetSession(int index, out IAudioSessionControl2 control);
    }
    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioSessionControl2 {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string icon);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string icon, ref Guid context);
        [PreserveSig] int GetGroupingParam(out Guid grouping);
        [PreserveSig] int SetGroupingParam(ref Guid grouping, ref Guid context);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetProcessId(out uint id);
    }
    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ISimpleAudioVolume {
        [PreserveSig] int SetMasterVolume(float volume, ref Guid context); [PreserveSig] int GetMasterVolume(out float volume);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context); [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }
    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioMeterInformation {
        [PreserveSig] int GetPeakValue(out float peak);
    }
}
