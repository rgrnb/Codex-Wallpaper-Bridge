using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;

namespace CodexWallpaperBridge {
  // HWND-only Windows Graphics Capture. No monitor capture API is used.
  internal sealed class WgcCapture : IDisposable {
    [ComImport, Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IItemInterop { IntPtr CreateForWindow(IntPtr window, ref Guid iid); IntPtr CreateForMonitor(IntPtr monitor, ref Guid iid); }
    [ComImport, Guid("a9b3d012-3df2-4ee3-b8d1-8695f457d3c1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDxgiAccess { IntPtr GetInterface(ref Guid iid); }
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int driver, IntPtr software, uint flags, IntPtr levels, uint levelCount, uint sdk, out IntPtr device, out int featureLevel, out IntPtr context);
    [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgi, out IntPtr inspectable);
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] static extern int WindowsCreateString(string source, int length, out IntPtr value);
    [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr value);
    [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr name, ref Guid iid, out IntPtr factory);
    [StructLayout(LayoutKind.Sequential)] struct TextureDesc { public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CpuAccessFlags, MiscFlags; }
    [StructLayout(LayoutKind.Sequential)] struct Mapped { public IntPtr Data; public uint RowPitch, DepthPitch; }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void GetDesc(IntPtr self, out TextureDesc desc);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateTexture(IntPtr self, ref TextureDesc desc, IntPtr initial, out IntPtr texture);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void CopyResource(IntPtr self, IntPtr destination, IntPtr source);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Map(IntPtr self, IntPtr resource, uint subresource, uint mode, uint flags, out Mapped mapped);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void Unmap(IntPtr self, IntPtr resource, uint subresource);
    static T Method<T>(IntPtr obj, int index) { return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj), index * IntPtr.Size), typeof(T)); }
    readonly IntPtr window; IntPtr device, context, staging; IDirect3DDevice runtimeDevice;
    Direct3D11CaptureFramePool pool; GraphicsCaptureSession session; readonly AutoResetEvent arrived = new AutoResetEvent(false);
    uint stagingWidth, stagingHeight; int poolWidth, poolHeight; volatile bool disposed; Bitmap lastFrame;
    public IntPtr Window { get { return window; } }
    public WgcCapture(IntPtr hwnd) {
      window = hwnd;
      if (!GraphicsCaptureSession.IsSupported()) throw new Exception("FRAME_WGC_NOT_SUPPORTED");
      string stage = "DEVICE";
      try {
        int level; Marshal.ThrowExceptionForHR(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out device, out level, out context));
        var dxgiGuid = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c"); IntPtr dxgi;
        Marshal.ThrowExceptionForHR(Marshal.QueryInterface(device, ref dxgiGuid, out dxgi));
        try {
          IntPtr inspectable; Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out inspectable));
          try { runtimeDevice = (IDirect3DDevice)Marshal.GetObjectForIUnknown(inspectable); } finally { Marshal.Release(inspectable); }
        } finally { Marshal.Release(dxgi); }
        stage = "FACTORY";
        IntPtr name, factoryPointer; string runtimeClass = "Windows.Graphics.Capture.GraphicsCaptureItem";
        Marshal.ThrowExceptionForHR(WindowsCreateString(runtimeClass, runtimeClass.Length, out name));
        var factoryGuid = new Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356");
        try { Marshal.ThrowExceptionForHR(RoGetActivationFactory(name, ref factoryGuid, out factoryPointer)); }
        finally { WindowsDeleteString(name); }
        IItemInterop factory;
        try { factory = (IItemInterop)Marshal.GetObjectForIUnknown(factoryPointer); } finally { Marshal.Release(factoryPointer); }
        stage = "ITEM";
        var itemGuid = new Guid("79c3f95b-31f7-4ec2-a464-632ef5d30760"); var itemPointer = factory.CreateForWindow(hwnd, ref itemGuid);
        GraphicsCaptureItem item;
        try { item = (GraphicsCaptureItem)Marshal.GetObjectForIUnknown(itemPointer); } finally { Marshal.Release(itemPointer); }
        stage = "POOL"; pool = Direct3D11CaptureFramePool.CreateFreeThreaded(runtimeDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, item.Size);
        poolWidth = item.Size.Width; poolHeight = item.Size.Height;
        pool.FrameArrived += delegate { if (!disposed) { try { arrived.Set(); } catch (ObjectDisposedException) { } } };
        stage = "SESSION"; session = pool.CreateCaptureSession(item); session.IsCursorCaptureEnabled = false;
        session.StartCapture();
      } catch (Exception error) { Dispose(); throw new Exception("FRAME_WGC_" + stage + "_" + error.GetType().Name.ToUpperInvariant() + "_" + unchecked((uint)error.HResult).ToString("X8")); }
    }
    public Bitmap Next() {
      if (!arrived.WaitOne(120)) {
        if (lastFrame != null) return (Bitmap)lastFrame.Clone();
        if (!arrived.WaitOne(1880)) throw new Exception("FRAME_WGC_TIMEOUT");
      }
      var frame = pool.TryGetNextFrame();
      if (frame == null) { if(lastFrame!=null)return (Bitmap)lastFrame.Clone(); throw new Exception("FRAME_WGC_EMPTY"); }
      var contentSize = frame.ContentSize;
      try {
        if(contentSize.Width<1 || contentSize.Height<1)return null;
        IntPtr texture = IntPtr.Zero;
        try {
          var guid = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c"); texture = ((IDxgiAccess)frame.Surface).GetInterface(ref guid);
          TextureDesc desc; Method<GetDesc>(texture, 10)(texture, out desc);
          if (desc.Width == 0 || desc.Height == 0 || (long)desc.Width * desc.Height > 16777216) throw new Exception("FRAME_SIZE_INVALID");
          if (staging == IntPtr.Zero || stagingWidth != desc.Width || stagingHeight != desc.Height) {
            if (staging != IntPtr.Zero) { Marshal.Release(staging); staging = IntPtr.Zero; }
            stagingWidth = desc.Width; stagingHeight = desc.Height;
            desc.Usage = 3; desc.BindFlags = 0; desc.CpuAccessFlags = 0x20000; desc.MiscFlags = 0;
            Marshal.ThrowExceptionForHR(Method<CreateTexture>(device, 5)(device, ref desc, IntPtr.Zero, out staging));
          }
          Method<CopyResource>(context, 47)(context, staging, texture);
          Mapped mapped; Marshal.ThrowExceptionForHR(Method<Map>(context, 14)(context, staging, 0, 1, 0, out mapped));
          try {
            int width = Math.Min((int)stagingWidth, frame.ContentSize.Width), height = Math.Min((int)stagingHeight, frame.ContentSize.Height);
            using (var wrapped = new Bitmap(width, height, (int)mapped.RowPitch, PixelFormat.Format32bppArgb, mapped.Data)) {
              var result = wrapped.Clone(new Rectangle(0, 0, width, height), PixelFormat.Format32bppRgb);
              if (lastFrame != null) lastFrame.Dispose(); lastFrame = (Bitmap)result.Clone(); return result;
            }
          } finally { Method<Unmap>(context, 15)(context, staging, 0); }
        } finally { if (texture != IntPtr.Zero) Marshal.Release(texture); }
      } finally {
          frame.Dispose();
          if (contentSize.Width > 0 && contentSize.Height > 0 && (long)contentSize.Width*contentSize.Height<=16777216 &&
              (contentSize.Width != poolWidth || contentSize.Height != poolHeight)) {
            // Recreate only after releasing the borrowed frame/surface. Otherwise
            // growing windows would remain cropped to the original pool size.
            pool.Recreate(runtimeDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, contentSize);
            poolWidth = contentSize.Width; poolHeight = contentSize.Height;
          }
      }
    }
    public void Dispose() {
      if (disposed) return; disposed = true;
      if (lastFrame != null) { lastFrame.Dispose(); lastFrame = null; }
      if (session != null) { session.Dispose(); session = null; }
      if (pool != null) { pool.Dispose(); pool = null; }
      if (runtimeDevice != null) { runtimeDevice.Dispose(); runtimeDevice = null; }
      if (staging != IntPtr.Zero) { Marshal.Release(staging); staging = IntPtr.Zero; }
      if (context != IntPtr.Zero) { Marshal.Release(context); context = IntPtr.Zero; }
      if (device != IntPtr.Zero) { Marshal.Release(device); device = IntPtr.Zero; }
      arrived.Dispose();
    }
  }
}
